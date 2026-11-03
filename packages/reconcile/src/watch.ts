/**
 * Reconciler service: runs the ledger <-> chain reconciliation every RECONCILE_INTERVAL_MS against
 * a gateway's admin API and an RPC. Logs one JSON line per run, exposes /healthz and /metrics, and
 * POSTs persistent problems (seen in two consecutive runs) to RECONCILE_ALERT_WEBHOOK_URL if set.
 */
import { createServer } from "node:http";
import { getAddress } from "viem";
import { z } from "zod";
import { publicClient } from "./chain";
import { Reconciler, type RunResult } from "./reconciler";
import { GatewayAdminClient } from "./sources";

const schema = z.object({
  PORT: z.coerce.number().int().default(8095),
  RECONCILE_GATEWAY_URL: z.string().url(),
  ADMIN_TOKEN: z.string().min(24),
  RPC_URL: z.string().url(),
  NETWORK: z.enum(["eip155:8453", "eip155:84532"]),
  PAY_TO: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  RECONCILE_FROM_BLOCK: z.coerce.bigint(),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(900_000),
  RECONCILE_CONFIRMATIONS: z.coerce.bigint().default(5n),
  RECONCILE_LOG_CHUNK: z.coerce.bigint().default(2_000n),
  RECONCILE_ALERT_WEBHOOK_URL: z.string().url().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(JSON.stringify({ level: "fatal", msg: "invalid configuration", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }));
  process.exit(1);
}
const cfg = parsed.data;

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: "reconciler", msg, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const reconciler = new Reconciler(publicClient(cfg.RPC_URL), new GatewayAdminClient(cfg.RECONCILE_GATEWAY_URL, cfg.ADMIN_TOKEN), {
  network: cfg.NETWORK,
  payTo: getAddress(cfg.PAY_TO),
  fromBlock: cfg.RECONCILE_FROM_BLOCK,
  confirmations: cfg.RECONCILE_CONFIRMATIONS,
  logChunk: cfg.RECONCILE_LOG_CHUNK,
});

let last: { at: number; result?: RunResult; error?: string } | null = null;
let runs = 0;
let failures = 0;

async function tick() {
  runs++;
  try {
    const result = await reconciler.run();
    last = { at: Date.now(), result };
    log(result.persistent.length ? "error" : result.ok ? "info" : "warn", "reconciliation run", {
      ok: result.ok,
      problems: result.problems.length,
      persistent: result.persistent,
      totals: result.totals,
      toBlock: result.toBlock,
      durationMs: result.durationMs,
    });
    if (result.persistent.length && cfg.RECONCILE_ALERT_WEBHOOK_URL) {
      await fetch(cfg.RECONCILE_ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `x402 reconciliation: ${result.persistent.length} persistent problem(s) on ${cfg.NETWORK}`, problems: result.persistent }),
        signal: AbortSignal.timeout(10_000),
      }).catch((e) => log("warn", "alert webhook failed", { err: String(e) }));
    }
  } catch (e) {
    failures++;
    last = { at: Date.now(), error: (e as Error).message };
    log("error", "reconciliation run failed", { err: (e as Error).message });
  }
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    // Healthy if the last run completed (a run that finds problems is still a healthy reconciler).
    const healthy = Boolean(last?.result) && Date.now() - last!.at < cfg.RECONCILE_INTERVAL_MS * 2 + 120_000;
    res.writeHead(healthy || !last ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: healthy, last_run: last ? new Date(last.at).toISOString() : null, error: last?.error ?? null }));
    return;
  }
  if (req.url === "/metrics") {
    const r = last?.result;
    const lines = [
      `reconcile_runs_total ${runs}`,
      `reconcile_run_failures_total ${failures}`,
      `reconcile_ok ${r?.ok ? 1 : 0}`,
      `reconcile_problems ${r?.problems.length ?? 0}`,
      `reconcile_persistent_problems ${r?.persistent.length ?? 0}`,
      `reconcile_settled_payments ${r?.totals.settledCount ?? 0}`,
      `reconcile_last_run_timestamp_seconds ${last ? Math.floor(last.at / 1000) : 0}`,
    ];
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(lines.join("\n") + "\n");
    return;
  }
  res.writeHead(404).end();
});

server.listen(cfg.PORT, () => log("info", "reconciler listening", { port: cfg.PORT, network: cfg.NETWORK, payTo: cfg.PAY_TO, fromBlock: cfg.RECONCILE_FROM_BLOCK, intervalMs: cfg.RECONCILE_INTERVAL_MS }));
await tick();
const timer = setInterval(() => void tick(), cfg.RECONCILE_INTERVAL_MS);
const shutdown = () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
