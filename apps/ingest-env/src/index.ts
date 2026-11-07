import { CARBON_INTENSITY, NesoClient, PgEnvStore } from "@mx/env";
import { Metrics } from "@mx/shared";
import { pino } from "pino";
import { loadConfig } from "./config";
import { healthServer } from "./health";
import { Poller } from "./poller";

/**
 * ingest-env: keeps every published version of the environmental datasets (architecture.md §6.2).
 * Several replicas are safe: the store serialises writers per dataset and appends only changes.
 */
const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { service: "ingest-env" } });

const store = new PgEnvStore(cfg.DATABASE_URL);
if (!(await store.schemaReady())) {
  log.fatal("env tables missing: run the gateway migrations (pnpm db:migrate) first");
  await store.close();
  process.exit(1);
}
const storage = (await store.hypertable()) ? "hypertable" : "plain";

const metrics = new Metrics();
metrics.describe("env_checks_total", "Source checks by result (fetched, unchanged, failed).");
metrics.describe("env_rows_changed_total", "Values appended because they changed.");
metrics.describe("env_rows_dropped_total", "Source rows with no valid period start.");
metrics.describe("env_rows_duplicate_total", "Source rows repeating a period within one fetch.");
metrics.describe("env_rows_flagged", "Values in the last fetch flagged missing or rejected.");
metrics.describe("env_last_success_timestamp_seconds", "When the last successful fetch completed.");
metrics.describe("env_publish_to_ingest_seconds", "Source publish time to stored, for the last fetch that changed data.");
metrics.describe("env_consecutive_failures", "Failed checks in a row.");

const neso = new NesoClient({ baseUrl: cfg.NESO_BASE_URL, timeoutMs: cfg.ENV_HTTP_TIMEOUT_MS });
const pollers = [CARBON_INTENSITY].map(
  (spec) =>
    new Poller(spec, neso, store, metrics, log, {
      checkMs: cfg.ENV_CHECK_INTERVAL_MS,
      maxFetchIntervalMs: cfg.ENV_MAX_FETCH_INTERVAL_MS,
      maxBackoffMs: cfg.ENV_MAX_BACKOFF_MS,
    }),
);

const server = healthServer({ metrics, statuses: () => pollers.map((p) => p.status), ping: () => store.ping(), storage: () => storage });
server.listen(cfg.ENV_HEALTH_PORT);
for (const p of pollers) p.start();
log.info({ datasets: pollers.map((p) => p.status.dataset), storage, source: cfg.NESO_BASE_URL, checkMs: cfg.ENV_CHECK_INTERVAL_MS }, "ingest-env running");

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  await Promise.all(pollers.map((p) => p.stop()));
  await new Promise<void>((r) => server.close(() => r()));
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
