import { serve } from "@hono/node-server";
import { Metrics } from "@mx/shared";
import { createApp } from "./app";
import { assertChain, createChain } from "./chain";
import { loadConfig } from "./config";
import { createFacilitator } from "./facilitator";
import { createLogger } from "./logger";

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
if (!cfg.AUTH_TOKEN) log.warn("AUTH_TOKEN not set: facilitator API is unauthenticated (development only)");

const { signer, probe } = createChain(cfg);
await assertChain(probe, cfg.NETWORK);
const metrics = new Metrics();
metrics.describe("facilitator_settle_total", "Settle requests by result");
metrics.describe("facilitator_gas_balance_wei", "Gas balance of the settling wallet at the last readiness check");

const app = createApp({ cfg, core: createFacilitator(signer, cfg.NETWORK), chain: probe, log, metrics });
const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) =>
  log.info({ port: info.port, network: cfg.NETWORK, signer: probe.address, payTo: [...cfg.ALLOWED_PAY_TO] }, "facilitator listening"),
);

function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  // Stop accepting requests; in-flight settles finish (the gateway reconciles any it loses track of).
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 25_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
