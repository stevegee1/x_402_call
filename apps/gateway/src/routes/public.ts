import { CREDIT_PACKS } from "@mx/shared";
import { Hono } from "hono";
import { isMainnet } from "../config";
import type { AppDeps, AppEnv } from "../context";
import type { PricedResource, Product } from "../platform/product";
import { renderSite, SITE_HEADERS, wantsHtml } from "./site";

const creditsOk = (r: PricedResource) => !r.rails || r.rails.includes("credits");
const sessionOk = (r: PricedResource) => !r.rails || r.rails.includes("session");
const priceOf = (r: PricedResource) => ({ price_usdc: r.pricing.priceUsd, price_credits_gbp: creditsOk(r) ? r.pricing.creditsGbpMicros / 1e6 : null, ...(r.rails ? { rails: r.rails } : {}) });

export function publicRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();

  const productSummary = (p: Product, base: string) => ({
    id: p.id,
    name: p.displayName,
    description: p.description,
    resources: p.resources.map((res) => ({ id: res.id, path: `${base}/v1/${p.id}${res.path}`, description: res.summary, ...priceOf(res) })),
  });

  r.get("/", (c) => {
    if (wantsHtml(c.req.header("accept"))) {
      const noindex: Record<string, string> = isMainnet(d.cfg) ? {} : { "x-robots-tag": "noindex" };
      return c.body(renderSite(d), 200, { ...SITE_HEADERS, ...noindex });
    }
    c.header("vary", "Accept");
    return c.json({
      service: "x402 data gateway",
      docs: `${d.cfg.PUBLIC_BASE_URL}/openapi.json`,
      products: d.catalog.products.map((p) => ({ id: p.id, name: p.displayName, catalog: `${d.cfg.PUBLIC_BASE_URL}/v1/products/${p.id}` })),
      payment: { x402: { network: d.cfg.X402_NETWORK, asset: "USDC", header: "PAYMENT-SIGNATURE" }, credits: { header: "Authorization: Bearer mk_..." } },
      identity: {
        seller: d.sellerIdentity ? { agent_registry: d.sellerIdentity.agentRegistry, agent_id: d.sellerIdentity.agentId } : null,
        // Buyers may declare their ERC-8004 agent; a verified identity raises their async allowance.
        buyer: d.identity ? { header: "X-Agent-Id", agent_registry: `${d.identity.policy.network}:${d.identity.policy.identityRegistry}` } : null,
      },
    });
  });

  r.get("/healthz", (c) => c.json({ ok: true }));

  r.get("/readyz", async (c) => {
    const db = await d.store.ping();
    const products = Object.fromEntries(d.catalog.products.map((p) => [p.id, p.status().ready]));
    const ok = db && Object.values(products).every(Boolean);
    return c.json({ ok, db, products, facilitator_breaker: d.facilitator.breaker.state }, ok ? 200 : 503);
  });

  r.get("/status", (c) =>
    c.json({
      uptime_s: Math.round((Date.now() - d.startedAt) / 1000),
      products: d.catalog.products.map((p) => {
        const s = p.status();
        return { id: p.id, name: p.displayName, ready: s.ready, scopes: s.scopes, ...s.detail };
      }),
      payments: { network: d.cfg.X402_NETWORK, settlement_mode: d.cfg.SETTLEMENT_MODE, facilitator_breaker: d.facilitator.breaker.state },
    }),
  );

  r.get("/v1/products", (c) => c.json({ data: d.catalog.products.map((p) => productSummary(p, d.cfg.PUBLIC_BASE_URL)) }));
  r.get("/v1/products/:id", (c) => {
    const p = d.catalog.product(c.req.param("id"));
    if (!p) return c.json({ error: "unknown_product", products: d.catalog.products.map((x) => x.id) }, 404);
    return c.json({ ...productSummary(p, d.cfg.PUBLIC_BASE_URL), status: p.status() });
  });

  // Public payment status lookup (ids are unguessable UUIDs returned only to the payer).
  r.get("/v1/payments/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "not_found" }, 404);
    const p = await d.store.getPayment(id);
    if (!p) return c.json({ error: "not_found" }, 404);
    return c.json({ id: p.id, status: p.status, network: p.network, resource: p.endpoint, amount_usdc: Number(p.amountAtomic) / 1e6, transaction: p.txHash, settled_at: p.settledAt?.toISOString() ?? null });
  });

  r.get("/metrics", async (c) => {
    // Global (all replicas): read from the payments table, not this process.
    const exposure = await d.store.exposure().catch(() => null);
    if (exposure) {
      d.metrics.set("x402_exposure_usdc_atomic", Number(exposure.totalAtomic));
      d.metrics.set("x402_exposure_payers", exposure.payers);
    }
    for (const p of d.catalog.products) {
      d.metrics.set("product_ready", p.status().ready ? 1 : 0, { product: p.id });
      p.collectMetrics?.(d.metrics);
    }
    return c.text(d.metrics.render(), 200, { "content-type": "text/plain; version=0.0.4" });
  });

  r.get("/openapi.json", (c) => c.json(openapi(d)));

  return r;
}

const toOpenApiPath = (p: string) => p.replace(/:(\w+)/g, "{$1}");

function openapi(d: AppDeps) {
  const paths: Record<string, unknown> = {};
  for (const route of d.catalog.paid) {
    const e = route.resource;
    const op = (deprecated: boolean) => ({
      get: {
        operationId: deprecated ? `${e.id}.legacy` : e.id,
        tags: [route.product.id],
        summary: e.summary,
        deprecated: deprecated || undefined,
        parameters: (e.parameters ?? []).map((p) => ({ ...p, required: p.in === "path" ? true : (p.required ?? false) })),
        "x-x402": { price_usdc: e.pricing.priceUsd, network: d.cfg.X402_NETWORK, pay_to: d.cfg.PAY_TO },
        ...(creditsOk(e) ? { "x-credits": { price_gbp: e.pricing.creditsGbpMicros / 1e6 } } : {}),
        security: [{}, ...(creditsOk(e) ? [{ credits: [] }] : []), ...(sessionOk(e) ? [{ session: [] }] : [])],
        responses: {
          "200": { description: "Data envelope: {mode, snapshot_ts, source_ts, degraded, data, …}" },
          "402": { description: "Payment required (x402 PAYMENT-REQUIRED header + JSON body; credits alternative in body)" },
          "404": { description: "Unknown scope or resource; not charged" },
          "503": { description: "Data stale, not for sale on this network, or payments unavailable; not charged" },
        },
      },
    });
    paths[toOpenApiPath(route.path)] = op(false);
    for (const legacy of e.legacyPaths ?? []) paths[toOpenApiPath(legacy)] = op(true);
  }
  for (const route of d.catalog.streams) {
    const e = route.resource;
    paths[toOpenApiPath(route.path)] = {
      get: {
        operationId: e.id,
        tags: [route.product.id],
        summary: e.summary,
        parameters: (e.parameters ?? []).map((p) => ({ ...p, required: p.in === "path" ? true : (p.required ?? false) })),
        "x-session": { price_usdc_per_event: e.pricing.priceUsd, buy: `${d.cfg.PUBLIC_BASE_URL}/v1/sessions/sizes` },
        security: [{ session: [] }],
        responses: {
          "200": { description: "text/event-stream: each event is charged from the session before it is sent; a final session_ended event closes the stream", content: { "text/event-stream": {} } },
          "401": { description: "Invalid or expired session; not charged" },
          "402": { description: "No session, or its balance is spent; not charged" },
          "503": { description: "Data stale or sessions unavailable; not charged" },
        },
      },
    };
  }
  for (const route of d.catalog.free) {
    paths[toOpenApiPath(route.path)] = { get: { tags: [route.product.id], summary: `Free: ${route.product.displayName} metadata`, responses: { "200": { description: "OK" } } } };
  }
  return {
    openapi: "3.1.0",
    info: { title: "x402 data gateway", version: "0.2.0" },
    servers: [{ url: d.cfg.PUBLIC_BASE_URL }],
    tags: d.catalog.products.map((p) => ({ name: p.id, description: p.description })),
    components: {
      securitySchemes: {
        credits: { type: "http", scheme: "bearer", description: "Prepaid GBP credits: Authorization: Bearer mk_..." },
        session: { type: "apiKey", in: "header", name: "Authorization", description: "x402 session: Authorization: Session <token> (buy at /v1/sessions/sizes)" },
      },
    },
    "x-credit-packs": Object.values(CREDIT_PACKS),
    paths,
  };
}
