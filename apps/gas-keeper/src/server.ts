import { serve } from "@hono/node-server";
import { Metrics } from "@mx/shared";
import { createApp } from "./app";
import { assertChain, assertEoas, createKeeperChain } from "./chain";
import { loadConfig } from "./config";
import { Keeper, WebhookAlerts } from "./keeper";
import { startLoop } from "./runner";
import { createLogger } from "./logger";

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);

const chain = createKeeperChain({ network: cfg.NETWORK, rpcUrl: cfg.RPC_URL, privateKey: cfg.KEEPER_PRIVATE_KEY as `0x${string}`, poolFee: cfg.POOL_FEE });
const metrics = new Metrics();
metrics.describe("gas_keeper_facilitator_balance_gwei", "Facilitator gas wallet balance at the last tick");
metrics.describe("gas_keeper_float_usdc", "USDC in the float wallet at the last tick");
metrics.describe("gas_keeper_settle_cost_usd", "Live gas cost of one x402 settle (measured gas units x gas price x Chainlink ETH/USD)");
metrics.describe("gas_keeper_settle_cost_over_allowance", "1 when one settle costs more than the network-fee allowance in prices, net of VAT");
metrics.describe("gas_keeper_topups_total", "Top-ups by result and kind (swap: USDC->ETH then send; send: from ETH already held)");
metrics.describe("gas_keeper_blocked_total", "Ticks that needed a top-up but refused one, by reason");
metrics.describe("gas_keeper_usdc_spent_total", "USDC spent on swaps since start");
metrics.describe("gas_keeper_alert_active", "1 while an alert is raised, by reason");

const alerts = new WebhookAlerts({ url: cfg.ALERT_WEBHOOK_URL, network: cfg.NETWORK, metrics, log });

// Refuse to run on the wrong chain or with a wallet that has code, but say so on the webhook first:
// a keeper that dies at boot leaves the facilitator unfunded.
try {
  await assertChain(chain, cfg.NETWORK);
  await assertEoas(chain, [chain.address, cfg.FACILITATOR_ADDRESS]);
} catch (e) {
  alerts.raise("startup_failed", `gas-keeper: refused to start (${(e as Error).message})`, {});
  await new Promise((r) => setTimeout(r, 12_000)); // let the webhook go out (its timeout is 10 s)
  throw e;
}
const keeper = new Keeper(
  chain,
  {
    facilitator: cfg.FACILITATOR_ADDRESS,
    facilitatorMinWei: cfg.FACILITATOR_MIN_ETH,
    triggerWei: cfg.TOPUP_TRIGGER_ETH,
    targetWei: cfg.TOPUP_TARGET_ETH,
    keeperReserveWei: cfg.KEEPER_RESERVE_ETH,
    maxUsdcPerTopup: cfg.MAX_USDC_PER_TOPUP,
    maxUsdcPerDay: cfg.MAX_USDC_PER_DAY,
    maxSlippageBps: cfg.MAX_SLIPPAGE_BPS,
    priceMaxAgeS: cfg.PRICE_MAX_AGE_S,
    floatLowUsdc: cfg.FLOAT_LOW_USDC,
    failAlertTicks: cfg.FAIL_ALERT_TICKS,
  },
  { metrics, log, alerts },
);

const app = createApp({ keeper, alerts, metrics, intervalMs: cfg.INTERVAL_MS });
const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) =>
  log.info({ port: info.port, network: cfg.NETWORK, keeper: chain.address, facilitator: cfg.FACILITATOR_ADDRESS }, "gas-keeper listening"),
);

const loop = startLoop(keeper, { intervalMs: cfg.INTERVAL_MS, startDelayMs: cfg.START_DELAY_MS }, log);

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  // The tick in flight finishes the one transaction it is waiting on (receipt waits are up to 60 s)
  // and starts no other; the next process waits for anything still pending before planning again.
  await loop.stop(cfg.SHUTDOWN_WAIT_MS);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
