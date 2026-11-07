import { randomUUID } from "node:crypto";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import type { Context, MiddlewareHandler } from "hono";
import { isMainnet } from "../config";
import type { AppDeps, AppEnv } from "../context";
import { looksLikeApiKey } from "../credits/keys";
import { creditsUsageJournal } from "../ledger/journal";
import type { PricedResource, Precheck, Product, Rail, Resolution } from "../platform/product";
import { usdToUsdcAtomic } from "@mx/shared";
import { AGENT_ID_HEADER, type TierDecision } from "../identity/tiers";
import { FacilitatorUnavailableError } from "./facilitator";

/** Async mode: give the request path this long to serve or cancel before the worker may settle. */
const ASYNC_SETTLE_DELAY_MS = 2_000;
/** If the authorization expires sooner than this, settle inline rather than queueing. */
const MIN_ASYNC_VALIDITY_MS = 30_000;

export const CREDITS_CHARGED_HEADER = "X-Credits-Charged-Gbp-Micros";
export const CREDITS_BALANCE_HEADER = "X-Credits-Balance-Gbp-Micros";
export const SESSION_CHARGED_HEADER = "X-Session-Charged-Usdc-Atomic";
export const SESSION_REMAINING_HEADER = "X-Session-Remaining-Usdc-Atomic";

const accepts = (resource: PricedResource, rail: Rail) => !resource.rails || resource.rails.includes(rail);

interface ExactAuthorization {
  from: string;
  to: string;
  value: string;
  validBefore: string;
  nonce: string;
}

/**
 * Charges for a product resource via one of two rails, then runs the handler:
 *   1. Fiat credits:  Authorization: Bearer mk_...       (identified B2B account, GBP prepaid)
 *   2. x402:          PAYMENT-SIGNATURE: <base64 payload> (account-free, USDC on Base)
 * With neither, responds 402 advertising both.
 *
 * Product-agnostic. Invariants enforced here for every product:
 *   - I1/I2: never charge for stale data, or for non-live data on mainnet (503 instead).
 *   - I5: the product precheck runs before any charge; credits are refunded and (async) x402
 *     payments cancelled if the handler returns >= 400.
 */
export function paid(product: Product, resource: PricedResource, d: AppDeps, precheck?: Precheck<unknown>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resolved = resolveForSale(product, c, d);
    if (resolved instanceof Response) return resolved;
    c.set("resolution", resolved);
    const rejected = precheck?.(c, resolved.state);
    if (rejected) return rejected;

    const auth = c.req.header("authorization");
    const sig = c.req.header("payment-signature");
    const rail: Rail | null = auth?.startsWith("Session ") ? "session" : auth?.startsWith("Bearer mk_") ? "credits" : sig ? "x402" : null;
    if (rail && !accepts(resource, rail)) {
      return c.json({ error: "rail_not_accepted", detail: `${resource.id} cannot be paid with ${rail}; you have not been charged`, accepted: resource.rails }, 400);
    }
    if (rail === "session") return chargeSession(c, next, resource, auth!.slice(8).trim(), d);
    if (rail === "credits") return chargeCredits(c, next, resource, auth!.slice(7), d);
    if (rail === "x402") return chargeX402(c, next, resource, sig!, d);

    if (c.req.header("x-payment")) return paymentRequired(c, resource, d, "x402_v1_not_supported: use PAYMENT-SIGNATURE (x402 v2)");
    return paymentRequired(c, resource, d);
  };
}

/**
 * The product's resolution, or the refusal that must come before any charge: unknown scope (the
 * product's response), stale data (I1) or non-live data on mainnet (I2). Shared by every paid path.
 */
export function resolveForSale(product: Product, c: Context<AppEnv>, d: AppDeps): Resolution<unknown> | Response {
  const resolved = product.resolve(c);
  if (resolved instanceof Response) return resolved;
  const { scope } = resolved;
  const labels = { product: product.id, scope: scope.scope };
  if (!scope.fresh) {
    d.metrics.inc("paid_requests_refused_total", { reason: "stale", ...labels });
    c.header("Retry-After", "30");
    return c.json({ error: "data_stale", detail: "data feed is stale; you have not been charged", source_ts: scope.sourceTs ? new Date(scope.sourceTs).toISOString() : null }, 503);
  }
  if (scope.mode !== "live" && isMainnet(d.cfg)) {
    d.metrics.inc("paid_requests_refused_total", { reason: "not_live", ...labels });
    return c.json({ error: "not_for_sale", detail: `serving ${scope.mode} data, which is never sold on mainnet` }, 503);
  }
  return resolved;
}

async function paymentRequired(c: Context<AppEnv>, resource: PricedResource, d: AppDeps, error?: string, extra: Record<string, unknown> = {}) {
  const reqs = await d.requirements.get(resource);
  const resourceUrl = `${d.cfg.PUBLIC_BASE_URL}${new URL(c.req.url).pathname}`;
  const pr = await d.resourceServer.createPaymentRequiredResponse(reqs, { url: resourceUrl, description: resource.summary, mimeType: "application/json" }, error);
  d.metrics.inc("payment_required_total", { resource: resource.id });
  c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(pr));
  c.header("Cache-Control", "private, no-store");
  return c.json(
    {
      ...pr,
      // Non-standard extension: the fiat alternative for identified business customers.
      credits: {
        price_gbp: resource.pricing.creditsGbpMicros / 1_000_000,
        usage: "Authorization: Bearer <api key>",
        signup: `${d.cfg.PUBLIC_BASE_URL}/v1/credits/accounts`,
      },
      ...(d.sellerIdentity ? { seller_identity: { agent_registry: d.sellerIdentity.agentRegistry, agent_id: d.sellerIdentity.agentId } } : {}),
      // Non-standard extension: prepay once with x402, then read at memory speed.
      ...(d.sessions && accepts(resource, "session") ? { sessions: { sizes: `${d.cfg.PUBLIC_BASE_URL}/v1/sessions/sizes`, usage: "Authorization: Session <token>" } } : {}),
      ...extra,
    },
    402,
  );
}

async function chargeCredits(c: Context<AppEnv>, next: () => Promise<void>, resource: PricedResource, apiKey: string, d: AppDeps) {
  if (!looksLikeApiKey(apiKey)) return c.json({ error: "invalid_api_key" }, 401);
  const account = await d.credits.resolveKey(apiKey);
  if (!account) return c.json({ error: "invalid_api_key" }, 401);
  if (account.status !== "active") return c.json({ error: "account_suspended" }, 403);
  c.set("account", account);

  const ref = c.get("requestId");
  const occurredAt = new Date().toISOString();
  const journal = creditsUsageJournal({ accountId: account.id, micros: resource.pricing.creditsGbpMicros, endpoint: resource.id, ref, occurredAt });
  const debit = await d.store.debit(account.id, resource.pricing.creditsGbpMicros, resource.id, journal);
  if (!debit.ok) {
    d.metrics.inc("credits_insufficient_total");
    return paymentRequired(c, resource, d, "insufficient_credits", {
      credits_balance_gbp: debit.balanceMicros / 1_000_000,
      topup: `${d.cfg.PUBLIC_BASE_URL}/v1/credits/checkout`,
    });
  }

  await next();

  if (c.res.status >= 400) {
    await d.store.refund(account.id, resource.pricing.creditsGbpMicros, creditsUsageJournal({ accountId: account.id, micros: resource.pricing.creditsGbpMicros, endpoint: resource.id, ref, occurredAt: new Date().toISOString(), refund: true }));
    c.res.headers.set(CREDITS_CHARGED_HEADER, "0");
    return;
  }
  d.metrics.inc("paid_requests_total", { rail: "credits", resource: resource.id });
  d.metrics.inc("credits_revenue_gbp_micros_total", { resource: resource.id }, resource.pricing.creditsGbpMicros);
  c.res.headers.set(CREDITS_CHARGED_HEADER, String(resource.pricing.creditsGbpMicros));
  c.res.headers.set(CREDITS_BALANCE_HEADER, String(debit.balanceMicros));
}

async function chargeX402(c: Context<AppEnv>, next: () => Promise<void>, resource: PricedResource, header: string, d: AppDeps) {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return paymentRequired(c, resource, d, "invalid_payment_header");
  }

  const reqs = await d.requirements.get(resource);
  const match = d.resourceServer.findMatchingRequirements(reqs, payload);
  if (!match) return paymentRequired(c, resource, d, "payment_does_not_match_requirements");

  const auth = (payload.payload as { authorization?: ExactAuthorization }).authorization;
  if (!auth?.from || !auth.nonce || !auth.validBefore) return paymentRequired(c, resource, d, "unsupported_payment_payload");
  const payer = auth.from.toLowerCase();

  const screening = await d.sanctions.screen(payer);
  if (screening.blocked) {
    d.metrics.inc("sanctions_blocked_total");
    d.log.warn({ payer, reason: screening.reason }, "payment refused: sanctions screening");
    return c.json({ error: "payment_refused" }, 403);
  }

  // ERC-8004 tier lookup runs alongside facilitator verification. It never throws: failures are "unknown".
  const unknown: TierDecision = { tier: "unknown", reason: "no_agent_id" };
  const tierLookup = d.identity ? d.identity.resolve(payer, c.req.header(AGENT_ID_HEADER)).catch(() => unknown) : Promise.resolve(unknown);

  let verify;
  try {
    verify = await d.resourceServer.verifyPayment(payload, match);
  } catch (e) {
    if (e instanceof FacilitatorUnavailableError || (e as Error).name === "BreakerOpenError") {
      d.metrics.inc("paid_requests_refused_total", { reason: "facilitator_unavailable" });
      c.header("Retry-After", "15");
      return c.json({ error: "payments_unavailable", detail: "payment verification is temporarily unavailable; you have not been charged" }, 503);
    }
    throw e;
  }
  if (!verify.isValid) {
    d.metrics.inc("x402_verify_invalid_total", { reason: verify.invalidReason ?? "unknown" });
    return paymentRequired(c, resource, d, verify.invalidReason ?? "payment_invalid");
  }

  const amount = BigInt(match.amount);
  const validBefore = new Date(Number(auth.validBefore) * 1000);
  // Async only if configured and the authorisation outlives the settle delay comfortably; the store
  // then admits it as async only if global and per-payer exposure (all replicas) stay within the caps.
  const wantAsync = d.cfg.SETTLEMENT_MODE === "async" && resource.settlement !== "sync" && validBefore.getTime() - Date.now() >= MIN_ASYNC_VALIDITY_MS;

  const [fx, tier] = await Promise.all([d.fx.usdcGbp(), tierLookup]);
  const id = randomUUID();
  const now = Date.now();
  const admission = await d.store.admitPayment(
    {
      id,
      network: match.network,
      payer,
      nonce: auth.nonce,
      amountAtomic: amount,
      endpoint: resource.id,
      resource: new URL(c.req.url).pathname,
      payload,
      requirements: match,
      validBefore,
      fxRate: fx.rate,
      fxSource: fx.source,
    },
    {
      wantAsync,
      caps: d.identity ? d.identity.capsFor(tier.tier) : d.exposureCaps,
      // Async: let the handler finish first. Sync: keep the worker away while we settle inline.
      asyncAttemptAt: new Date(now + ASYNC_SETTLE_DELAY_MS),
      syncAttemptAt: new Date(now + 120_000),
    },
  );
  if (admission.result === "duplicate") {
    d.metrics.inc("x402_replay_rejected_total");
    return paymentRequired(c, resource, d, "payment_already_used");
  }
  const sync = admission.mode === "sync";
  if (wantAsync && sync) d.metrics.inc("x402_exposure_cap_hits_total", { tier: tier.tier });

  if (sync) {
    const row = (await d.store.getPayment(id))!;
    const outcome = await d.settler.settleNow(row);
    if (!outcome.ok) {
      if (!outcome.final) return c.json({ error: "settlement_pending", payment_id: id, detail: "settlement did not complete; retry shortly" }, 503);
      return paymentRequired(c, resource, d, `settlement_failed: ${outcome.reason}`);
    }
    c.set("payment", { id, payer });
    await next();
    if (outcome.response) c.res.headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(outcome.response));
    c.res.headers.set("X-Payment-Id", id);
    c.res.headers.set("X-Settlement", "settled");
  } else {
    c.set("payment", { id, payer });
    await next();
    if (c.res.status >= 400) {
      // Cancelling also releases the exposure: it is derived from verified async rows.
      await d.store.cancelPayment(id, `handler_status_${c.res.status}`);
      return;
    }
    c.res.headers.set("X-Payment-Id", id);
    c.res.headers.set("X-Settlement", "pending");
  }
  c.res.headers.set("X-Agent-Tier", tier.tier);
  d.metrics.inc("paid_requests_total", { rail: "x402", resource: resource.id, mode: sync ? "sync" : "async", tier: tier.tier });
}

/**
 * Spends a prepaid x402 session (architecture.md §6.4): an HMAC check and an in-memory debit, so no
 * facilitator, chain or database on the read path. Refunded if the handler fails (I5).
 */
async function chargeSession(c: Context<AppEnv>, next: () => Promise<void>, resource: PricedResource, token: string, d: AppDeps) {
  if (!d.sessions) return c.json({ error: "sessions_disabled" }, 401);
  const price = usdToUsdcAtomic(resource.pricing.priceUsd);
  const r = await d.sessions.charge(token, resource.id, price);
  if (!r.ok) {
    d.metrics.inc("session_refused_total", { reason: r.reason });
    if (r.reason === "exhausted") return paymentRequired(c, resource, d, "session_exhausted");
    if (r.reason === "unavailable") {
      c.header("Retry-After", "5");
      return c.json({ error: "sessions_unavailable", detail: "session balance is temporarily unavailable; you have not been charged" }, 503);
    }
    if (r.reason === "expired" || r.reason === "closed") return c.json({ error: "session_expired", detail: "buy a new session" }, 401);
    return c.json({ error: "invalid_session" }, 401);
  }
  await next();
  if (c.res.status >= 400) {
    d.sessions.refund(r.ticket);
    c.res.headers.set(SESSION_CHARGED_HEADER, "0");
    return;
  }
  d.metrics.inc("paid_requests_total", { rail: "session", resource: resource.id });
  c.res.headers.set(SESSION_CHARGED_HEADER, price.toString());
  c.res.headers.set(SESSION_REMAINING_HEADER, r.remainingAtomic.toString());
}
