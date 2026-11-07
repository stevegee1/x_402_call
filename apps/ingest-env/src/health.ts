import { createServer, type Server } from "node:http";
import type { Metrics } from "@mx/shared";
import type { PollerStatus } from "./poller";

export interface HealthDeps {
  metrics: Metrics;
  statuses: () => PollerStatus[];
  /** Resolves when the database answers. */
  ping: () => Promise<void>;
  storage: () => "hypertable" | "plain";
}

/**
 * /healthz: the process is alive (never fails on upstream or DB trouble, so a NESO outage doesn't
 * get the service restarted in a loop). /readyz: the database answers. /status: per-dataset state.
 * /metrics: Prometheus text.
 */
export function healthServer(d: HealthDeps): Server {
  return createServer((req, res) => {
    const json = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") return json(200, { ok: true });
    if (path === "/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(d.metrics.render());
    if (path === "/readyz") {
      d.ping().then(
        () => json(200, { ok: true }),
        () => json(503, { ok: false, error: "database unavailable" }),
      );
      return;
    }
    if (path === "/status") {
      const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
      return json(200, {
        storage: d.storage(),
        datasets: d.statuses().map((s) => ({
          dataset: s.dataset,
          last_check_at: iso(s.lastCheckAt),
          last_success_at: iso(s.lastSuccessAt),
          last_published_at: iso(s.lastPublishedAt),
          last_rows_changed: s.lastChanged,
          consecutive_failures: s.consecutiveFailures,
          last_error: s.lastError,
        })),
      });
    }
    json(404, { error: "not_found" });
  });
}
