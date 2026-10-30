import { createFacilitatorConfig } from "@coinbase/x402";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createApp } from "./app";
import { loadConfig, isMainnet } from "./config";
import type { AppDeps } from "./context";
import { StripeCheckout } from "./credits/checkout";
import { CreditsService } from "./credits/service";
import { natsFeed, simulatorFeed } from "./feed";
import { CoinbaseFx } from "./ledger/fx";
import { createLogger } from "./logger";
import { Metrics } from "./metrics";
import { ExposureTracker, usdToAtomic } from "./payments/exposure";
import { FailoverFacilitator } from "./payments/facilitator";
import { createAuthorizationChecker } from "./payments/onchain";
import { SanctionsService } from "./payments/sanctions";
import { Settler } from "./payments/settlement";
import { createResourceServer, RequirementsCache } from "./payments/x402";
import { PANAMA_DRAUGHT_CONDITION } from "./routes/admin";
import { SnapshotEngine } from "./snapshot/engine";
import { WorldState } from "./snapshot/state";
import { migrate } from "./store/migrate";
import { MemoryStore } from "./store/memory";
import { PgStore } from "./store/pg";
import type { Store } from "./store/types";

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const metrics = new Metrics();

if (isMainnet(cfg) && cfg.DATA_SOURCE === "simulator") log.warn("mainnet with simulator data: all paid endpoints will refuse to charge");

// Persistence
let store: Store;
if (cfg.DATABASE_URL) {
  await migrate(cfg.DATABASE_URL, (m) => log.info(m));
  store = new PgStore(cfg.DATABASE_URL);
} else {
  log.warn("DATABASE_URL not set: using in-memory store (development only, not durable)");
  store = new MemoryStore();
}

// Data plane
const world = new WorldState();
const feed = cfg.DATA_SOURCE === "nats" ? await natsFeed(cfg.NATS_URL, world, log, metrics) : simulatorFeed(world);
const engine = new SnapshotEngine(world, cfg.SNAPSHOT_INTERVAL_MS);
const draught = await store.getCondition(PANAMA_DRAUGHT_CONDITION);
if (draught) {
  engine.draughtLimits.panama = { value_m: (draught.value as { value_m: number }).value_m, source: draught.source, updated_at: draught.updatedAt.toISOString() };
}
engine.start();

// Payments
const primary = new HTTPFacilitatorClient({
  ...(cfg.FACILITATOR === "cdp"
    ? createFacilitatorConfig(cfg.CDP_API_KEY_ID, cfg.CDP_API_KEY_SECRET)
    : { url: cfg.FACILITATOR === "url" ? cfg.FACILITATOR_URL : "https://x402.org/facilitator" }),
  timeoutMs: cfg.FACILITATOR_TIMEOUT_MS,
});
const fallback = cfg.FALLBACK_FACILITATOR_URL ? new HTTPFacilitatorClient({ url: cfg.FALLBACK_FACILITATOR_URL, timeoutMs: cfg.FACILITATOR_TIMEOUT_MS }) : undefined;
const facilitator = new FailoverFacilitator(primary, fallback, (name, state) => {
  metrics.set("breaker_open", state === "open" ? 1 : 0, { breaker: name });
  log.warn({ breaker: name, state }, "circuit breaker state change");
});
const resourceServer = createResourceServer(facilitator, cfg.X402_NETWORK);
await resourceServer.initialize();
const requirements = new RequirementsCache(resourceServer, { payTo: cfg.PAY_TO, network: cfg.X402_NETWORK, maxTimeoutSeconds: cfg.MAX_TIMEOUT_SECONDS });
await requirements.warm();

const exposure = new ExposureTracker(usdToAtomic(cfg.EXPOSURE_CAP_USD), usdToAtomic(cfg.EXPOSURE_CAP_PER_PAYER_USD));
exposure.rehydrate(await store.unsettledByPayer());
const checker = cfg.BASE_RPC_URL ? createAuthorizationChecker(cfg.X402_NETWORK, cfg.BASE_RPC_URL) : undefined;
if (!checker) log.warn("BASE_RPC_URL not set: indeterminate settlements cannot be reconciled on-chain");
const settler = new Settler(store, resourceServer, exposure, log, metrics, checker);
settler.start();

const sanctions = new SanctionsService({
  denylistPath: cfg.SANCTIONS_DENYLIST_PATH,
  chainalysisApiKey: cfg.CHAINALYSIS_API_KEY,
  failClosed: cfg.SANCTIONS_FAIL_CLOSED,
  onError: (e) => {
    metrics.inc("sanctions_screening_errors_total");
    log.warn({ err: e }, "sanctions screening unavailable");
  },
});

// Fiat credits
const checkout = cfg.STRIPE_SECRET_KEY && cfg.STRIPE_WEBHOOK_SECRET ? new StripeCheckout(cfg.STRIPE_SECRET_KEY, cfg.STRIPE_WEBHOOK_SECRET) : undefined;
if (!checkout) log.warn("Stripe not configured: card top-ups disabled (manual/bank top-ups still available)");
const credits = new CreditsService(store, checkout, { publicBaseUrl: cfg.PUBLIC_BASE_URL, keyEnv: isMainnet(cfg) ? "live" : "test" });

const deps: AppDeps = {
  cfg,
  log,
  metrics,
  store,
  engine,
  credits,
  resourceServer,
  requirements,
  facilitator,
  settler,
  exposure,
  sanctions,
  fx: new CoinbaseFx(cfg.FX_FALLBACK_USDC_GBP),
  feedConnected: feed.connected,
  startedAt: Date.now(),
};

const server = serve({ fetch: createApp(deps).fetch, port: cfg.PORT }, (info) =>
  log.info({ port: info.port, network: cfg.X402_NETWORK, dataSource: cfg.DATA_SOURCE, settlement: cfg.SETTLEMENT_MODE }, "gateway listening"),
);

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  server.close();
  engine.stop();
  settler.stop();
  // Give in-flight settlements a moment; anything unfinished is re-claimed after its lease expires.
  await new Promise((r) => setTimeout(r, 1_000));
  await feed.close();
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
