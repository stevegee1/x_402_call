import type { AppDeps } from "../context";
import type { PricedResource, Product, ResourceParameter } from "../platform/product";

/**
 * One description of what we sell, shared by the JSON catalog (/v1/products), the OpenAPI spec and
 * the human pages (/catalog, /docs), so they can never disagree.
 */

export const creditsOk = (r: PricedResource) => !r.rails || r.rails.includes("credits");
export const sessionOk = (r: PricedResource) => !r.rails || r.rails.includes("session");
export const x402Ok = (r: PricedResource) => !r.rails || r.rails.includes("x402");

/** `/v1/grid/:country/intensity` -> `/v1/grid/{country}/intensity` (OpenAPI and docs style). */
export const templatePath = (p: string) => p.replace(/:(\w+)/g, "{$1}");

export interface EndpointView {
  id: string;
  kind: "paid" | "stream" | "free";
  method: "GET";
  /** Path template, `{param}` style. */
  path: string;
  summary: string;
  parameters: ResourceParameter[];
  /** null when that way of paying isn't accepted. Free endpoints have all three null. */
  pay: {
    x402: { price_usdc: string } | null;
    credits: { price_gbp: number } | null;
    session: { price_usdc: string } | null;
  };
  /** A runnable example path: path parameters filled, required query parameters given. */
  example: string;
}

export interface ScopeView {
  id: string;
  name: string;
  mode: string;
  fresh: boolean;
  data_age_s: number | null;
  vessels?: number;
}

export interface ProductView {
  id: string;
  name: string;
  description: string;
  kind: "data" | "access";
  ready: boolean;
  coverage: ScopeView[];
  endpoints: EndpointView[];
}

/** A value an example request can use for this parameter. */
function exampleValue(p: ResourceParameter, coverage: ScopeView[], now: Date): string {
  const s = p.schema as { type?: string; enum?: unknown[]; format?: string; minimum?: number };
  if (Array.isArray(s.enum) && s.enum.length) {
    // Prefer a scope that's fresh right now, so the example works when tried.
    const fresh = coverage.find((c) => c.fresh && s.enum!.includes(c.id));
    return String(fresh?.id ?? s.enum[0]);
  }
  if (s.format === "date-time") {
    const t = new Date(now);
    t.setUTCMinutes(t.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    t.setUTCHours(t.getUTCHours() - 24);
    return t.toISOString().replace(".000Z", "Z");
  }
  if (p.name === "mmsi") return "235000000";
  if (s.type === "number" || s.type === "integer") return String(s.minimum !== undefined && s.minimum > 0 ? Math.max(s.minimum, 1) : 1);
  return p.name;
}

function exampleFor(path: string, params: ResourceParameter[], coverage: ScopeView[], now: Date): string {
  let out = path;
  const query: string[] = [];
  for (const p of params) {
    if (p.in === "path") out = out.replace(`:${p.name}`, encodeURIComponent(exampleValue(p, coverage, now)));
    else if (p.required) query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(exampleValue(p, coverage, now))}`);
  }
  return query.length ? `${out}?${query.join("&")}` : out;
}

function scopesOf(p: Product): ScopeView[] {
  return p.status().scopes.map((s) => {
    const x = s as typeof s & { name?: string; vessels?: number; data_age_s?: number | null };
    return {
      id: s.scope,
      name: x.name ?? s.scope.charAt(0).toUpperCase() + s.scope.slice(1),
      mode: s.mode,
      fresh: s.fresh,
      data_age_s: x.data_age_s ?? (s.sourceTs ? Math.round((Date.now() - s.sourceTs) / 1000) : null),
      ...(typeof x.vessels === "number" ? { vessels: x.vessels } : {}),
    };
  });
}

export function catalogView(d: AppDeps, now = new Date()): ProductView[] {
  return d.catalog.products.map((p) => {
    const kind = p.kind ?? "data";
    // Access products (sessions) have one synthetic scope; it isn't coverage.
    const coverage = kind === "data" ? scopesOf(p) : [];
    const paid = new Map(d.catalog.paid.filter((r) => r.product === p).map((r) => [r.resource.id, r]));
    const streams = new Map(d.catalog.streams.filter((r) => r.product === p).map((r) => [r.resource.id, r]));
    const endpoints: EndpointView[] = [];
    for (const f of d.catalog.free.filter((r) => r.product === p)) {
      endpoints.push({ id: `${p.id}.${f.path.split("/").pop()}`, kind: "free", method: "GET", path: templatePath(f.path), summary: f.summary ?? "Free metadata", parameters: [], pay: { x402: null, credits: null, session: null }, example: f.path });
    }
    for (const res of p.resources) {
      const route = paid.get(res.id) ?? streams.get(res.id);
      if (!route) continue;
      const stream = streams.has(res.id);
      endpoints.push({
        id: res.id,
        kind: stream ? "stream" : "paid",
        method: "GET",
        path: templatePath(route.path),
        summary: res.summary,
        parameters: (res.parameters ?? []).map((x) => ({ ...x, required: x.in === "path" ? true : (x.required ?? false) })),
        pay: {
          x402: !stream && x402Ok(res) ? { price_usdc: res.pricing.priceUsd } : null,
          credits: !stream && creditsOk(res) ? { price_gbp: res.pricing.creditsGbpMicros / 1e6 } : null,
          session: sessionOk(res) && kind === "data" ? { price_usdc: res.pricing.priceUsd } : null,
        },
        example: exampleFor(route.path, res.parameters ?? [], coverage, now),
      });
    }
    return { id: p.id, name: p.displayName, description: p.description, kind, ready: p.status().ready, coverage, endpoints };
  });
}
