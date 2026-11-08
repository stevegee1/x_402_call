import { z, type ZodTypeAny } from "zod";

/**
 * Builds MCP tools from the gateway's JSON catalog (/v1/products), so every product and endpoint
 * the gateway sells (and every one it adds later) is available to the agent without a code change.
 * Pure: no I/O, so it is unit-tested against catalog fixtures.
 */

export interface CatalogParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema: { type?: string; enum?: unknown[]; format?: string; minimum?: number; maximum?: number };
}

export interface CatalogEndpoint {
  id: string;
  kind: "paid" | "stream" | "free";
  path: string; // template, {param} style
  summary: string;
  parameters: CatalogParameter[];
  pay: { x402: { price_usdc: string } | null; credits: { price_gbp: number } | null; session: { price_usdc: string } | null };
}

export interface CatalogProduct {
  id: string;
  name: string;
  description: string;
  kind: "data" | "access";
  coverage?: { id: string; name: string; mode: string; fresh: boolean }[];
  endpoints?: CatalogEndpoint[];
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  endpoint: CatalogEndpoint;
  product: CatalogProduct;
  inputSchema: Record<string, ZodTypeAny>;
  /** The request path for validated arguments. */
  path(args: Record<string, unknown>): string;
}

/** `grid.intensity` -> `grid_intensity` (MCP tool names: letters, digits, _ and -). */
export const toolName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function zodFor(p: CatalogParameter): ZodTypeAny {
  const s = p.schema ?? {};
  let t: ZodTypeAny;
  if (Array.isArray(s.enum) && s.enum.length && s.enum.every((v) => typeof v === "string")) t = z.enum(s.enum as [string, ...string[]]);
  else if (s.type === "integer" || s.type === "number") {
    let n = s.type === "integer" ? z.number().int() : z.number();
    if (typeof s.minimum === "number") n = n.min(s.minimum);
    if (typeof s.maximum === "number") n = n.max(s.maximum);
    t = n;
  } else if (s.type === "boolean") t = z.boolean();
  else t = z.string().min(1);
  const desc = [p.description, s.format === "date-time" ? "ISO 8601 with a zone, e.g. 2026-11-07T00:00:00Z" : ""].filter(Boolean).join(". ");
  if (desc) t = t.describe(desc);
  return p.in === "path" || p.required ? t : t.optional();
}

function priceLine(e: CatalogEndpoint): string {
  if (e.kind === "free") return "Free.";
  const parts: string[] = [];
  if (e.pay.x402) parts.push(`${e.pay.x402.price_usdc} USDC (x402)`);
  if (e.pay.credits) parts.push(`£${e.pay.credits.price_gbp} (credits)`);
  if (e.pay.session) parts.push(`${e.pay.session.price_usdc} USDC from a session`);
  return `Paid: ${parts.join(", ")}.`;
}

/**
 * One tool per non-stream endpoint. Streams (server-sent events) don't fit a request/response tool
 * call, so they are left to direct clients.
 */
export function buildTools(products: CatalogProduct[]): ToolDef[] {
  const out: ToolDef[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    if (product.kind === "access") continue; // sessions: bought through buy_session, not as data
    for (const e of product.endpoints ?? []) {
      if (e.kind === "stream") continue;
      const name = toolName(e.id);
      if (seen.has(name)) continue;
      seen.add(name);
      const inputSchema: Record<string, ZodTypeAny> = {};
      for (const p of e.parameters ?? []) inputSchema[p.name] = zodFor(p);
      const coverage = product.coverage?.length ? ` Coverage: ${product.coverage.map((c) => `${c.id}${c.mode !== "live" ? ` (${c.mode})` : c.fresh ? "" : " (delayed)"}`).join(", ")}.` : "";
      out.push({
        name,
        title: `${product.name}: ${e.summary}`.slice(0, 100),
        description: `${priceLine(e)} ${e.summary}.${coverage} You are never charged for errors or stale data.`,
        endpoint: e,
        product,
        inputSchema,
        path: (args) => buildPath(e, args),
      });
    }
  }
  return out;
}

export function buildPath(e: CatalogEndpoint, args: Record<string, unknown>): string {
  let path = e.path;
  const q = new URLSearchParams();
  for (const p of e.parameters ?? []) {
    const v = args[p.name];
    if (p.in === "path") {
      if (v === undefined || v === null || v === "") throw new Error(`missing path parameter ${p.name}`);
      path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
    } else if (v !== undefined && v !== null && v !== "") q.set(p.name, String(v));
  }
  if (/\{[^}]+\}/.test(path)) throw new Error(`unfilled path parameter in ${path}`);
  return q.size ? `${path}?${q}` : path;
}

/** Keep tool results small enough for a model's context: cap any top-level `data` array. */
export function trimForModel(body: unknown, limit: number): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.data) && b.data.length > limit) return { ...b, data: b.data.slice(0, limit), truncated: true, returned: limit, total: b.data.length };
  return body;
}
