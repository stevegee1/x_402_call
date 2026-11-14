import { CREDIT_PACKS } from "@mx/shared";
import { Hono } from "hono";
import { isMainnet } from "../config";
import type { AppDeps, AppEnv } from "../context";
import type { PricedResource, Product } from "../platform/product";
import { viewerOf } from "../customers/web-session";
import { degradedReasonOf, statusOf } from "../platform/product-watch";
import { catalogView, creditsOk, sessionOk, templatePath, type ProductView } from "./catalog-model";
import { DOCS_HEADERS, renderCatalogPage, renderDocsPage } from "./docs-pages";
import { renderSite, SITE_HEADERS, wantsHtml } from "./site";

const priceOf = (r: PricedResource) => ({ price_usdc: r.pricing.priceUsd, price_credits_gbp: creditsOk(r) ? r.pricing.creditsGbpMicros / 1e6 : null, ...(r.rails ? { rails: r.rails } : {}) });

export function publicRoutes(d: AppDeps) {
  const r = new Hono<AppEnv>();

  /**
   * One product in the JSON catalog. `resources` is the original shape, kept for existing clients;
   * `endpoints` is the full description (every way to pay, parameters, a runnable example).
   */
  const productSummary = (p: Product, base: string, v: ProductView) => ({
    id: p.id,
    name: p.displayName,
    description: p.description,
    kind: v.kind,
    ready: v.ready,
    coverage: v.coverage,
    endpoints: v.endpoints.map((e) => ({ ...e, url: `${base}${e.path}`, example_url: `${base}${e.example}`, docs: `${base}/docs#${e.id}` })),
    resources: p.resources.map((res) => ({ id: res.id, path: `${base}/v1/${p.id}${res.path}`, description: res.summary, ...priceOf(res) })),
  });
  const viewOf = (p: Product) => catalogView(d).find((v) => v.id === p.id)!;
  const docsLinks = () => ({ api_reference: `${d.cfg.PUBLIC_BASE_URL}/docs`, openapi: `${d.cfg.PUBLIC_BASE_URL}/openapi.json`, catalog: `${d.cfg.PUBLIC_BASE_URL}/catalog` });
  const htmlHeaders = () => ({ ...DOCS_HEADERS, ...(isMainnet(d.cfg) ? {} : { "x-robots-tag": "noindex" }) });

  r.get("/", async (c) => {
    if (wantsHtml(c.req.header("accept"))) {
      const noindex: Record<string, string> = isMainnet(d.cfg) ? {} : { "x-robots-tag": "noindex" };
      return c.body(renderSite(d, await viewerOf(c, d)), 200, { ...SITE_HEADERS, ...noindex });
    }
    c.header("vary", "Accept");
    return c.json({
      service: "x402 data gateway",
      docs: `${d.cfg.PUBLIC_BASE_URL}/openapi.json`,
      api_reference: `${d.cfg.PUBLIC_BASE_URL}/docs`,
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

  /**
   * Ready = this replica can take money correctly, which needs the database (payments, replay
   * protection, exposure caps, ledger). Products never gate it: each sale is gated by its scope's
   * freshness (resolveForSale, 503 uncharged), so one product's feed outage (say, the maritime NATS
   * bus) must not fail every deploy or make the other products look down. `degraded` lists products
   * that can't sell right now; ProductWatch alerts when one stays degraded (a bad deploy included).
   */
  r.get("/readyz", async (c) => {
    const db = await d.store.ping();
    // A product whose status throws is reported, not propagated: readiness is about the database.
    const statuses = d.catalog.products.map((p) => [p.id, statusOf(p)] as const);
    const products = Object.fromEntries(statuses.map(([id, s]) => [id, s.ready]));
    const degraded = statuses.filter(([, s]) => degradedReasonOf(s) !== null).map(([id]) => id);
    return c.json({ ok: db, db, products, degraded, facilitator_breaker: d.facilitator.breaker.state }, db ? 200 : 503);
  });

  r.get("/status", (c) =>
    c.json({
      uptime_s: Math.round((Date.now() - d.startedAt) / 1000),
      products: d.catalog.products.map((p) => {
        const s = statusOf(p);
        return { id: p.id, name: p.displayName, ready: s.ready, scopes: s.scopes, ...s.detail };
      }),
      payments: { network: d.cfg.X402_NETWORK, settlement_mode: d.cfg.SETTLEMENT_MODE, facilitator_breaker: d.facilitator.breaker.state },
    }),
  );

  // People get pages, agents and SDKs get JSON, from the same URLs (Vary: Accept).
  r.get("/catalog", async (c) => c.body(renderCatalogPage(d, await viewerOf(c, d)), 200, htmlHeaders()));
  r.get("/docs", async (c) => c.body(renderDocsPage(d, openapi(d), await viewerOf(c, d)), 200, htmlHeaders()));

  r.get("/v1/products", async (c) => {
    c.header("vary", "Accept");
    if (wantsHtml(c.req.header("accept")) && c.req.query("format") !== "json") return c.body(renderCatalogPage(d, await viewerOf(c, d)), 200, htmlHeaders());
    const views = catalogView(d);
    return c.json({ data: d.catalog.products.map((p) => productSummary(p, d.cfg.PUBLIC_BASE_URL, views.find((v) => v.id === p.id)!)), docs: docsLinks() });
  });
  r.get("/v1/products/:id", (c) => {
    c.header("vary", "Accept");
    const p = d.catalog.product(c.req.param("id"));
    if (wantsHtml(c.req.header("accept")) && c.req.query("format") !== "json") {
      return p ? c.body(null, 302, { location: `/catalog#${p.id}`, vary: "Accept" }) : c.body(renderCatalogPage(d), 404, htmlHeaders());
    }
    if (!p) return c.json({ error: "unknown_product", products: d.catalog.products.map((x) => x.id) }, 404);
    return c.json({ ...productSummary(p, d.cfg.PUBLIC_BASE_URL, viewOf(p)), status: statusOf(p), docs: docsLinks() });
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
      d.metrics.set("product_ready", statusOf(p).ready ? 1 : 0, { product: p.id });
      try {
        p.collectMetrics?.(d.metrics);
      } catch (e) {
        // One product's metrics bug must not blank the whole scrape (the degraded gauges live here).
        d.metrics.inc("product_metrics_errors_total", { product: p.id });
        d.log.warn({ err: e, product: p.id }, "product metrics failed");
      }
    }
    return c.text(d.metrics.render(), 200, { "content-type": "text/plain; version=0.0.4" });
  });

  r.get("/openapi.json", async (c) => {
    c.header("vary", "Accept");
    // A browser gets the readable reference; tools (and ?format=json, the download link) get the spec.
    if (wantsHtml(c.req.header("accept")) && c.req.query("format") !== "json") return c.body(renderDocsPage(d, openapi(d), await viewerOf(c, d)), 200, htmlHeaders());
    return c.json(openapi(d));
  });

  return r;
}

const toOpenApiPath = templatePath;

export type OpenApiDoc = ReturnType<typeof openapi>;

export function openapi(d: AppDeps) {
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
          "200": { description: "Data envelope", content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } },
          "402": { description: "Payment required: x402 PAYMENT-REQUIRED header, and the price in the body (credits alternative included); not charged", content: { "application/json": { schema: { $ref: "#/components/schemas/PaymentRequired" } } } },
          "404": { description: "Unknown scope or resource; not charged", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "Data stale, not for sale on this network, or payments unavailable; not charged", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
    paths[toOpenApiPath(route.path)] = {
      get: { operationId: `${route.product.id}.${route.path.split("/").pop()}`, tags: [route.product.id], summary: route.summary ?? `${route.product.displayName} metadata`, "x-free": true, responses: { "200": { description: "OK (free, no payment)" } } },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "wearebase data API",
      version: "0.3.0",
      description: [
        "Maritime and energy-grid intelligence, sold per request.",
        "",
        "Three ways to pay for a paid endpoint:",
        "- x402 (no account): call it, get 402 with a USDC price, sign the payment with your wallet and repeat the call with the PAYMENT-SIGNATURE header.",
        "- Credits (GBP, prepaid): Authorization: Bearer mk_... from your account at /account.",
        "- Session (prepaid x402): buy one at /v1/sessions/{size}, then Authorization: Session <token>. Streams need a session.",
        "",
        "Every data response says its mode (live or simulated) and how fresh it is. You are never charged for a 4xx or 5xx, or for stale data (503).",
      ].join("\n"),
    },
    externalDocs: { description: "API reference (human-readable)", url: `${d.cfg.PUBLIC_BASE_URL}/docs` },
    servers: [{ url: d.cfg.PUBLIC_BASE_URL }],
    tags: d.catalog.products.map((p) => ({ name: p.id, "x-displayName": p.displayName, description: p.description })),
    components: {
      schemas: {
        Envelope: {
          type: "object",
          description: "Every data response. mode is always present; the timing fields depend on the product (maritime: snapshot_ts, source_ts, degraded; grid: generated_at, forecast_until).",
          required: ["mode"],
          properties: {
            mode: { type: "string", enum: ["live", "simulated", "replay"], description: "Only live data is sold on mainnet" },
            snapshot_ts: { type: "string", format: "date-time", description: "Maritime: when this snapshot was built" },
            source_ts: { type: ["string", "null"], format: "date-time", description: "Maritime: newest AIS report in it" },
            degraded: { type: "boolean", description: "Maritime: the feed is behind (paid calls return 503 instead)" },
            generated_at: { type: "string", format: "date-time", description: "Grid: when this answer was computed" },
            forecast_until: { type: ["string", "null"], format: "date-time", description: "Grid: end of the forecast horizon" },
          },
          additionalProperties: true,
        },
        PaymentRequired: {
          type: "object",
          properties: {
            x402Version: { type: "integer" },
            accepts: { type: "array", items: { type: "object", description: "x402 payment requirements: scheme, network, asset, amount, payTo" } },
            credits: { type: "object", description: "How to pay with GBP credits instead, when accepted" },
          },
          additionalProperties: true,
        },
        Error: { type: "object", required: ["error"], properties: { error: { type: "string" }, detail: { type: "string" } }, additionalProperties: true },
      },
      securitySchemes: {
        credits: { type: "http", scheme: "bearer", description: "Prepaid GBP credits: Authorization: Bearer mk_..." },
        session: { type: "apiKey", in: "header", name: "Authorization", description: "x402 session: Authorization: Session <token> (buy at /v1/sessions/sizes)" },
      },
    },
    "x-credit-packs": Object.values(CREDIT_PACKS),
    paths,
  };
}
