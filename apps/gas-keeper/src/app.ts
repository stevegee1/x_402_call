import type { Metrics } from "@mx/shared";
import { Hono } from "hono";
import type { Keeper } from "./keeper";

export interface AppDeps {
  keeper: Pick<Keeper, "last">;
  alerts: { activeReasons(): string[] };
  metrics: Metrics;
  intervalMs: number;
  now?: () => number;
}

/**
 * Private HTTP surface: liveness, readiness and metrics. /healthz is the deploy health check and
 * never depends on the chain; /readyz fails when ticks stop completing.
 */
export function createApp(d: AppDeps) {
  const app = new Hono();
  const now = () => d.now?.() ?? Date.now();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", (c) => {
    const last = d.keeper.last;
    const fresh = last !== null && now() - last.at < d.intervalMs * 3;
    const ready = fresh && last!.result.ok;
    return c.json({ ready, last: last && { at: new Date(last.at).toISOString(), ...last.result }, alerts: d.alerts.activeReasons() }, ready ? 200 : 503);
  });

  app.get("/metrics", (c) => c.text(d.metrics.render(), 200, { "content-type": "text/plain; version=0.0.4" }));

  return app;
}
