import type { DataMode } from "@mx/shared";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { Metrics } from "../metrics";

/**
 * The contract between the platform kernel and a vertical product (maritime, data centre, …).
 * See architecture.md §3.
 *
 * Products own their data plane, handlers and prices. The kernel owns billing, settlement, the
 * ledger, trust and every invariant on the money path. Products never import kernel internals
 * (enforced by test/platform/boundaries.test.ts).
 */

/** Fixed price per call, on both rails. (Metered pricing is designed in architecture.md §6, not implemented.) */
export interface FixedPricing {
  kind: "fixed";
  /** USD decimal string, VAT-inclusive, settled in USDC (≤ 6 dp). */
  priceUsd: string;
  /** GBP micros, net of VAT (VAT is charged at credits top-up). */
  creditsGbpMicros: number;
}

export interface ResourceParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

export interface PricedResource {
  /** Namespaced id, `<productId>.<name>`. Stored on payments, usage rows and journal memos. */
  id: string;
  /** Hono path pattern relative to `/v1/<productId>`, e.g. `/:region/vessels`. */
  path: string;
  summary: string;
  pricing: FixedPricing;
  /** OpenAPI parameters (path parameters must match the pattern). */
  parameters?: ResourceParameter[];
  /** Absolute pre-platform paths still served as deprecated aliases (e.g. `/v1/:region/vessels`). */
  legacyPaths?: string[];
  /** "sync": always settle on chain before the handler runs (e.g. buying a session). Default: SETTLEMENT_MODE. */
  settlement?: "sync";
  /** Rails that may pay for this resource. Default: all. */
  rails?: readonly Rail[];
}

/** x402: per-call USDC. credits: GBP prepaid account. session: a prepaid x402 session token. */
export type Rail = "x402" | "credits" | "session";

/** What a request will read, as far as the money path cares. */
export interface ResolvedScope {
  /** Product-defined scope, e.g. a region id. Used in metrics and status. */
  scope: string;
  /** false → 503, never charged (invariant I1). */
  fresh: boolean;
  /** Anything but "live" on mainnet → 503, never charged (invariant I2). */
  mode: DataMode;
  /** Epoch ms of the newest upstream data, if known. */
  sourceTs: number | null;
}

export interface Resolution<S> {
  scope: ResolvedScope;
  /** Product-owned state for this request (e.g. the region snapshot). Passed to precheck and handler unchanged. */
  state: S;
}

export interface ScopeStatus extends ResolvedScope {
  /** Extra product-specific fields for /status (e.g. vessel count). */
  [key: string]: unknown;
}

export interface ProductStatus {
  /** Contributes to /readyz: false makes the gateway unready. */
  ready: boolean;
  scopes: ScopeStatus[];
  detail?: Record<string, unknown>;
}

export type ProductContext = Context<AppEnv>;
export type Handler = (c: ProductContext) => Response | Promise<Response>;
export type PaidHandler<S> = (c: ProductContext, state: S) => Response | Promise<Response>;
/** Cheap validation run BEFORE charging (invariant I5): return a Response to refuse without charge. */
export type Precheck<S> = (c: ProductContext, state: S) => Response | null;

/**
 * Sends one event to a stream subscriber. The kernel charges the resource's price from the
 * subscriber's session first; false means the stream has ended (balance spent, session expired,
 * or the client left) and the product should stop sending.
 */
export type StreamEmit = (event: string, data: unknown) => Promise<boolean>;
/** Called once per subscriber with an emitter; returns the function that unsubscribes it. */
export type StreamOpen<S> = (c: ProductContext, state: S, emit: StreamEmit) => () => void;

export interface ProductRoutes<S> {
  /** Registers the handler for a declared resource. Every declared resource must get exactly one. */
  paid(resourceId: string, handler: PaidHandler<S>, opts?: { precheck?: Precheck<S> }): void;
  /**
   * Server-sent events for a declared resource. Paid per event, only from an x402 session (the
   * resource must take rails ["session"]); the product's `open` sends events through `emit`.
   */
  stream(resourceId: string, open: StreamOpen<S>): void;
  /** Free GET route under `/v1/<productId>`. */
  free(path: string, handler: Handler, opts?: { legacyPaths?: string[]; summary?: string }): void;
  /** Operator route under `/admin/<productId>`, behind admin auth. */
  admin(method: "GET" | "POST" | "PUT", path: string, handler: Handler): void;
}

export interface Product<S = unknown> {
  /** URL and ledger namespace. Lower-case, stable forever once money has been taken under it. */
  readonly id: string;
  /** Human name for status pages, OpenAPI and the agent card. */
  readonly displayName: string;
  readonly description: string;
  /**
   * "data" (default) sells data. "access" sells a way to pay for other products (x402 sessions):
   * it has no data of its own, so status pages and the site don't present it as a data feed.
   */
  readonly kind?: "data" | "access";
  readonly resources: readonly PricedResource[];
  /** Maps a request to its scope and state, or returns a Response (e.g. 404 unknown scope, never charged). */
  resolve(c: ProductContext): Resolution<S> | Response;
  routes(r: ProductRoutes<S>): void;
  status(): ProductStatus;
  /** Refresh product gauges before /metrics renders. */
  collectMetrics?(m: Metrics): void;
}
