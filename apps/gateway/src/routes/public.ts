import { PAID_ENDPOINTS, REGIONS, REGION_IDS, CREDIT_PACKS } from "@mx/shared";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../context";

export function publicRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();

  const regionStatus = () =>
    REGION_IDS.map((id) => {
      const s = d.engine.get(id);
      return {
        id,
        name: REGIONS[id].name,
        status: REGIONS[id].status,
        mode: s.mode,
        vessels: s.vessels.length,
        stale: s.stale,
        source_ts: s.sourceTs ? new Date(s.sourceTs).toISOString() : null,
        data_age_s: s.sourceTs ? Math.round((Date.now() - s.sourceTs) / 1000) : null,
      };
    });

  r.get("/", (c) =>
    c.json({
      service: "Maritime data gateway (x402)",
      docs: `${d.cfg.PUBLIC_BASE_URL}/openapi.json`,
      regions: `${d.cfg.PUBLIC_BASE_URL}/v1/regions`,
      payment: { x402: { network: d.cfg.X402_NETWORK, asset: "USDC", header: "PAYMENT-SIGNATURE" }, credits: { header: "Authorization: Bearer mk_..." } },
    }),
  );

  r.get("/healthz", (c) => c.json({ ok: true }));

  r.get("/readyz", async (c) => {
    const db = await d.store.ping();
    const feed = d.feedConnected();
    const ok = db && feed;
    return c.json({ ok, db, feed, facilitator_breaker: d.facilitator.breaker.state }, ok ? 200 : 503);
  });

  r.get("/status", (c) =>
    c.json({
      uptime_s: Math.round((Date.now() - d.startedAt) / 1000),
      snapshot_build_ms: Math.round(d.engine.lastBuildMs * 100) / 100,
      snapshot_interval_ms: d.cfg.SNAPSHOT_INTERVAL_MS,
      regions: regionStatus(),
      payments: { network: d.cfg.X402_NETWORK, settlement_mode: d.cfg.SETTLEMENT_MODE, facilitator_breaker: d.facilitator.breaker.state },
    }),
  );

  r.get("/v1/regions", (c) =>
    c.json({
      data: regionStatus().map((s) => ({
        ...s,
        bbox: REGIONS[s.id].bbox,
        anchorages: REGIONS[s.id].anchorages.map((a) => ({ id: a.id, name: a.name })),
        endpoints: Object.values(PAID_ENDPOINTS).map((e) => ({
          path: e.path.replace(":region", s.id),
          price_usdc: e.priceUsd,
          price_credits_gbp: e.creditsGbpMicros / 1e6,
          description: e.description,
        })),
      })),
    }),
  );

  // Public payment status lookup (ids are unguessable UUIDs returned only to the payer).
  r.get("/v1/payments/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "not_found" }, 404);
    const p = await d.store.getPayment(id);
    if (!p) return c.json({ error: "not_found" }, 404);
    return c.json({ id: p.id, status: p.status, network: p.network, amount_usdc: Number(p.amountAtomic) / 1e6, transaction: p.txHash, settled_at: p.settledAt?.toISOString() ?? null });
  });

  r.get("/metrics", (c) => {
    d.metrics.set("x402_exposure_usdc_atomic", Number(d.exposure.total));
    for (const id of REGION_IDS) {
      const s = d.engine.get(id);
      d.metrics.set("region_vessels", s.vessels.length, { region: id });
      d.metrics.set("region_stale", s.stale ? 1 : 0, { region: id });
      d.metrics.set("region_data_age_seconds", s.sourceTs ? (Date.now() - s.sourceTs) / 1000 : -1, { region: id });
    }
    d.metrics.set("snapshot_build_ms", d.engine.lastBuildMs);
    return c.text(d.metrics.render(), 200, { "content-type": "text/plain; version=0.0.4" });
  });

  r.get("/openapi.json", (c) => c.json(openapi(d)));

  return r;
}

function openapi(d: AppDeps) {
  const paths: Record<string, unknown> = {};
  for (const e of Object.values(PAID_ENDPOINTS)) {
    const params = [{ name: "region", in: "path", required: true, schema: { type: "string", enum: REGION_IDS } }];
    if (e.id === "vessel") params.push({ name: "mmsi", in: "path", required: true, schema: { type: "integer" } as never });
    paths[e.path.replace(/:(\w+)/g, "{$1}")] = {
      get: {
        summary: e.description,
        parameters: params,
        "x-x402": { price_usdc: e.priceUsd, network: d.cfg.X402_NETWORK, pay_to: d.cfg.PAY_TO },
        "x-credits": { price_gbp: e.creditsGbpMicros / 1e6 },
        security: [{}, { credits: [] }],
        responses: {
          "200": { description: "Snapshot envelope: {region, mode, snapshot_seq, snapshot_ts, source_ts, degraded, data}" },
          "402": { description: "Payment required (x402 PAYMENT-REQUIRED header + JSON body; credits alternative in body)" },
          "503": { description: "Data stale or payments unavailable; not charged" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Maritime data gateway", version: "0.1.0" },
    servers: [{ url: d.cfg.PUBLIC_BASE_URL }],
    components: { securitySchemes: { credits: { type: "http", scheme: "bearer" } } },
    "x-credit-packs": Object.values(CREDIT_PACKS),
    paths,
  };
}
