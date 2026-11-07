import type { AddressInfo } from "node:net";
import { Metrics } from "@mx/shared";
import { afterEach, describe, expect, it } from "vitest";
import { healthServer } from "../src/health";
import type { PollerStatus } from "../src/poller";

const status: PollerStatus = {
  dataset: "neso.carbon_intensity",
  lastCheckAt: Date.parse("2026-11-07T14:10:30Z"),
  lastSuccessAt: Date.parse("2026-11-07T14:10:00Z"),
  lastPublishedAt: Date.parse("2026-11-07T14:09:40Z"),
  lastChanged: 3,
  consecutiveFailures: 0,
  lastError: null,
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(dbUp: boolean) {
  const metrics = new Metrics();
  metrics.inc("env_checks_total", { dataset: "neso.carbon_intensity", result: "fetched" });
  const s = healthServer({
    metrics,
    statuses: () => [status],
    ping: async () => {
      if (!dbUp) throw new Error("down");
    },
    storage: () => "plain",
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  close = () => new Promise((r) => s.close(() => r()));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return (path: string) => fetch(base + path);
}

describe("healthServer", () => {
  it("stays live when the database is down, and reports not ready", async () => {
    const get = await serve(false);
    expect((await get("/healthz")).status).toBe(200);
    const r = await get("/readyz");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: "database unavailable" });
  });

  it("reports ready when the database answers", async () => {
    const get = await serve(true);
    expect((await get("/readyz")).status).toBe(200);
  });

  it("serves per-dataset status in ISO times", async () => {
    const get = await serve(true);
    expect(await (await get("/status?x=1")).json()).toEqual({
      storage: "plain",
      datasets: [
        {
          dataset: "neso.carbon_intensity",
          last_check_at: "2026-11-07T14:10:30.000Z",
          last_success_at: "2026-11-07T14:10:00.000Z",
          last_published_at: "2026-11-07T14:09:40.000Z",
          last_rows_changed: 3,
          consecutive_failures: 0,
          last_error: null,
        },
      ],
    });
  });

  it("serves Prometheus metrics and 404s anything else", async () => {
    const get = await serve(true);
    const m = await get("/metrics");
    expect(m.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await m.text()).toContain('env_checks_total{dataset="neso.carbon_intensity",result="fetched"} 1');
    expect((await get("/nope")).status).toBe(404);
  });
});
