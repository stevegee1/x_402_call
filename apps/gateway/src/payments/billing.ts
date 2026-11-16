import { randomUUID } from "node:crypto";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import type { Context, MiddlewareHandler } from "hono";
import { isMainnet } from "../config";
import type { AppDeps, AppEnv } from "../context";
import { looksLikeApiKey } from "../credits/keys";
import { creditsUsageJournal } from "../ledger/journal";
import type { PricedResource, Precheck, Product, Rail, Resolution } from "../platform/product";
import type { PaymentRow } from "../store/types";
import { usdToUsdcAtomic } from "@mx/shared";
import { AGENT_ID_HEADER, type TierDecision } from "../identity/tiers";
import { FacilitatorUnavailableError } from "./facilitator";
import { EXPIRY_GRACE_MS, type SettleOutcome } from "./settlement";

/** Async mode: give the request path this long to serve or cancel before the worker may settle. */
/** An async x402 payment can be settled this long after admission: a handler must answer well inside it. */
export const ASYNC_SETTLE_DELAY_MS = 2_000;
/** If the authorization expires sooner than this, settle inline rather than queueing. */
const MIN_ASYNC_VALIDITY_MS = 30_000;
/**
 * How long one delivery of an owed payment may hold it before it is presumed dead (a replica that
 * died mid-request). Far above any handler's time; a handler slower than this could let a second
 * delivery start, which serves data twice but can never charge twice or clear another's lease.
 */
const REDEEM_LEASE_MS = 120_000;
/** Set on a response whose payment settled but whose data was not delivered: resend the same signature. */
export const PAYMENT_OWED_HEADER = "X-Payment-Owed";

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
 *   - I5: the product precheck runs before any charge; credits are refunded and x402 payments
 *     cancelled if the handler returns >= 400 (in sync mode the handler runs before the settle).
 *   - I14: a sync x402 payment is owed from admission until its response goes out. One that settled
 *     but never reached the buyer (settle outcome unknown, client gone, replica died) is served once
 *     when the same PAYMENT-SIGNATURE is resent; a resource that must settle first (sessions) too.
 */
export function paid(product: Product, resource: PricedResource, d: AppDeps, precheck?: Precheck<unknown>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Paid routes are GETs; Hono also routes HEAD to them, which would charge (any rail) for a body
    // that is never sent.
    if (c.req.method !== "GET") return c.json({ error: "method_not_payable", detail: `pay for ${resource.id} with a GET; you have not been charged` }, 405, { Allow: "GET" });
    const resolved = resolveForSale(product, c, d);
    if (resolved instanceof Response) return flagOwedRefusal(c, resolved, d);
    c.set("resolution", resolved);
    const rejected = precheck?.(c, resolved.state);
    if (rejected) return flagOwedRefusal(c, rejected, d);

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

async function paymentRequired(c: Context<AppEnv>, resource: PricedResource, d: AppDeps, error?: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const reqs = await d.requirements.get(resource);
  const resourceUrl = `${d.cfg.PUBLIC_BASE_URL}${new URL(c.req.url).pathname}`;
  const pr = await d.resourceServer.createPaymentRequiredResponse(reqs, { url: resourceUrl, description: resource.summary, mimeType: "application/json" }, error);
  d.metrics.inc("payment_required_total", { resource: resource.id });
  // A standalone Response (not c.json): it may replace a handler's response after the fact.
  return json(
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
    { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr), "Cache-Control": "private, no-store" },
  );
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Replaces the response a handler produced, without inheriting any of its headers. */
function replaceResponse(c: Context<AppEnv>, res: Response) {
  c.res = undefined as unknown as Response; // Hono copies the old response's headers on assignment
  c.res = res;
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

  const auth = (payload.payload as { authorization?: ExactAuthorization } | undefined)?.authorization;
  if (!auth?.from || !auth.nonce || !auth.validBefore) return paymentRequired(c, resource, d, "unsupported_payment_payload");
  const payer = auth.from.toLowerCase();

  // A resent signature: the authorization is already recorded (its nonce may be spent on chain, so
  // the facilitator would refuse it). Answer from our own record, before matching today's price list:
  // a debt stays redeemable after a price or config change (I14). It was screened when it was paid.
  const existing = await recordedPayment(payload, payer, auth.nonce, d);
  if (existing) return resend(c, next, resource, payload, existing, d);

  const reqs = await d.requirements.get(resource);
  const match = d.resourceServer.findMatchingRequirements(reqs, payload);
  if (!match) return paymentRequired(c, resource, d, "payment_does_not_match_requirements");

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
      failures: d.failurePolicy,
      now: new Date(now),
      // Async: let the handler finish first. Sync: keep the worker away while we settle inline.
      asyncAttemptAt: new Date(now + ASYNC_SETTLE_DELAY_MS),
      // Sync: unarmed until the request path hands it to the facilitator (armPayment). If the request
      // dies first, the worker only sees it once the authorization has expired past the grace, when
      // settleNow can only confirm on chain or fail it ("not charged"): it never submits it.
      syncAttemptAt: new Date(validBefore.getTime() + EXPIRY_GRACE_MS + 5_000),
    },
  );
  if (admission.result === "duplicate") {
    d.metrics.inc("x402_replay_rejected_total");
    return paymentRequired(c, resource, d, "payment_already_used");
  }
  const sync = admission.mode === "sync";
  if (admission.syncReason === "cap") d.metrics.inc("x402_exposure_cap_hits_total", { tier: tier.tier });
  if (admission.syncReason === "demoted") d.metrics.inc("x402_async_demoted_total", { tier: tier.tier });

  if (sync) {
    // Owed from admission (I14). The handler runs FIRST and its response is held until the payment
    // settles: a handler failure is cancelled before any money moves (I5), and data leaves only once
    // paid. The data ages by the settle time (about 1 to 3 s), the price of never charging for a
    // response that can't be produced.
    const row = (await d.store.getPayment(id))!;
    // A resource that must settle before its handler runs (buying a session: the handler issues a
    // token valid from settlement) is settled first and delivered under the lease, like a resend.
    if (resource.settlement === "sync") {
      const outcome = await settleInline(row, d);
      if (!outcome.ok) return settleRefusal(c, resource, d, id, outcome);
      const delivered = await deliver(c, next, { ...row, status: "settled", txHash: outcome.response?.transaction || null }, d, outcome.response);
      if (delivered.kind === "busy") return delivered.response;
      if (delivered.kind === "owed") d.metrics.inc("x402_owed_total", { reason: delivered.reason, resource: resource.id });
      c.res.headers.set("X-Agent-Tier", tier.tier);
      d.metrics.inc("paid_requests_total", { rail: "x402", resource: resource.id, mode: "sync", tier: tier.tier });
      return;
    }
    c.set("payment", { id, payer });
    await next();
    if (c.res.status >= 400 || c.req.raw.signal?.aborted) {
      // Never armed, so even if this write fails the worker can't charge it later.
      await d.store.cancelPayment(id, c.res.status >= 400 ? `handler_status_${c.res.status}` : "client_gone_before_settle").catch((e) => d.log.error({ err: e, paymentId: id }, "cancel failed; the payment stays unarmed, never charged"));
      return;
    }
    // Retry transient facilitator failures in place; if it still fails with a known outcome, the
    // payment is failed for good (never settled later), so "not charged" below is true.
    const outcome = await settleInline(row, d);
    if (!outcome.ok) {
      await c.res.body?.cancel().catch(() => {});
      return replaceResponse(c, await settleRefusal(c, resource, d, id, outcome));
    }
    // Paid. The response goes out now; the debt is cleared unless the client is already gone.
    const delivered = !c.req.raw.signal?.aborted;
    const token = await d.store.claimOwed(id, REDEEM_LEASE_MS).catch(() => null);
    if (token) await finish(id, token, delivered, d);
    if (!delivered) d.metrics.inc("x402_owed_total", { reason: "client_gone", resource: resource.id });
    if (outcome.response) c.res.headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(outcome.response));
    c.res.headers.set("X-Payment-Id", id);
    c.res.headers.set("X-Settlement", "settled");
    if (!delivered) c.res.headers.set(PAYMENT_OWED_HEADER, "true");
  } else {
    // Async: the worker may settle from this moment. A handler that can be slow must answer (and so
    // let a >= 400 cancel) before it; see GridHistory's store-read budget.
    c.set("payment", { id, payer, settleNotBefore: now + ASYNC_SETTLE_DELAY_MS });
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
 * Settles a sync payment on the request path. It is armed for the worker first, so if this process
 * dies mid-settle the worker and the chain check finish it. Any error once the settle has started
 * (a store write after the facilitator moved the funds, say) is an unknown outcome, never a 500
 * that leaves the buyer charged with nothing to go on.
 */
async function settleInline(row: PaymentRow, d: AppDeps): Promise<SettleOutcome> {
  try {
    await d.store.armPayment(row.id, new Date(Date.now() + 120_000));
  } catch (e) {
    // The write may have committed before the error reached us, so the worker could still pick it
    // up. "Not charged" is only true once it is cancelled; otherwise the outcome is unknown.
    d.log.error({ err: e, paymentId: row.id }, "could not arm a sync payment");
    try {
      await d.store.cancelPayment(row.id, "arm_failed");
      return { ok: false, reason: "payments_unavailable", final: true };
    } catch {
      return { ok: false, reason: "indeterminate: arm_failed", final: false, indeterminate: true };
    }
  }
  try {
    return await d.settler.settleNow(row, { inline: true, finalizeOnFailure: true });
  } catch (e) {
    d.metrics.inc("x402_settle_inline_errors_total");
    d.log.error({ err: e, paymentId: row.id }, "sync settle errored mid-flight; the worker will resolve it");
    return { ok: false, reason: `indeterminate: ${(e as Error).message}`, final: false, indeterminate: true };
  }
}

/**
 * The answer when a sync settle didn't complete. Unknown outcome (timeout): the worker and the
 * on-chain check finish it, and if it settles the buyer resends the same signature and is served
 * from the debt (I14). Known failure: failed for good, never settled later, so "not charged" is true.
 */
async function settleRefusal(c: Context<AppEnv>, resource: PricedResource, d: AppDeps, id: string, outcome: { reason: string; final: boolean }): Promise<Response> {
  if (!outcome.final) {
    d.metrics.inc("x402_settle_unknown_total", { resource: resource.id });
    return json(
      {
        error: "settlement_pending",
        payment_id: id,
        detail: `settlement outcome unknown. Resend the same PAYMENT-SIGNATURE to get the data once /v1/payments/${id} shows settled; you will not be charged twice. Do not sign a new payment.`,
      },
      503,
      { "Retry-After": "5", "X-Payment-Id": id },
    );
  }
  return paymentRequired(c, resource, d, `settlement_failed: ${outcome.reason}`);
}

/**
 * Ends a delivery. A store error must not turn a served response into a 500: the debt then simply
 * stays owed (redeemable again) and the lease expires on its own.
 */
async function finish(id: string, token: string, delivered: boolean, d: AppDeps) {
  try {
    await d.store.finishOwed(id, token, delivered);
  } catch (e) {
    d.metrics.inc("x402_owed_finish_failed_total");
    d.log.error({ err: e, paymentId: id }, "could not record delivery; the payment stays owed");
  }
}

/** The payment already recorded for this signed authorization, if any. */
async function recordedPayment(payload: PaymentPayload, payer: string, nonce: string, d: AppDeps) {
  const network = typeof payload.accepted?.network === "string" ? payload.accepted.network : null;
  return network ? d.store.paymentByNonce(network, payer, nonce) : null;
}

/**
 * A refusal before any charge (stale data, a precheck) is honest for a new payment. For a resend of
 * an owed payment it is not "not charged": mark it owed, so the buyer keeps the debt and retries.
 */
async function flagOwedRefusal(c: Context<AppEnv>, refusal: Response, d: AppDeps): Promise<Response> {
  const header = c.req.header("payment-signature");
  if (!header) return refusal;
  try {
    const payload = decodePaymentSignatureHeader(header);
    const auth = (payload.payload as { authorization?: ExactAuthorization } | undefined)?.authorization;
    if (!auth?.from || !auth.nonce) return refusal;
    const row = await recordedPayment(payload, auth.from.toLowerCase(), auth.nonce, d);
    // Settled, or still settling (it may yet settle): either way the buyer must keep the debt.
    const mine = row && signatureOf(row.payload) === signatureOf(payload) && row.resource === new URL(c.req.url).pathname;
    if (mine && row.owedSince && (row.status === "settled" || row.status === "verified")) {
      const res = new Response(refusal.body, refusal);
      res.headers.set(PAYMENT_OWED_HEADER, "true");
      res.headers.set("X-Payment-Id", row.id);
      return res;
    }
  } catch {
    // An undecodable header is refused as usual by the payment path; nothing is owed.
  }
  return refusal;
}

const signatureOf = (p: unknown) => (p as { payload?: { signature?: unknown } } | null)?.payload?.signature;

/** How a delivery attempt of an owed payment ended. */
type Delivery = { kind: "delivered" } | { kind: "owed"; reason: "handler_failed" | "client_gone" } | { kind: "busy"; response: Response };

/**
 * Serves an owed, settled payment under a redemption lease (I14): the original sync request and
 * every resend go through here, so the debt is cleared only by a response that carries the data.
 * Returns busy when another request holds the lease (it is delivering right now).
 */
async function deliver(c: Context<AppEnv>, next: () => Promise<void>, row: PaymentRow, d: AppDeps, settle?: SettleResponse | null): Promise<Delivery> {
  const token = await d.store.claimOwed(row.id, REDEEM_LEASE_MS);
  if (!token) {
    c.header("Retry-After", "2");
    c.header("X-Payment-Id", row.id);
    return { kind: "busy", response: c.json({ error: "redemption_in_progress", payment_id: row.id, detail: "another request is delivering this payment's data; resend shortly" }, 409) };
  }
  let result: Delivery = { kind: "owed", reason: "handler_failed" };
  try {
    c.set("payment", { id: row.id, payer: row.payer });
    await next();
    // A client that hung up never received the data, whatever we produced (best effort: a
    // disconnect after the response is handed to the socket is indistinguishable from delivery).
    if (c.req.raw.signal?.aborted) result = { kind: "owed", reason: "client_gone" };
    else if (c.res.status < 400) result = { kind: "delivered" };
  } finally {
    await finish(row.id, token, result.kind === "delivered", d);
  }
  const response = settle ?? (row.txHash ? { success: true, transaction: row.txHash, network: row.network as `${string}:${string}`, payer: row.payer } : null);
  if (response) c.res.headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(response));
  c.res.headers.set("X-Payment-Id", row.id);
  c.res.headers.set("X-Settlement", "settled");
  if (result.kind !== "delivered") c.res.headers.set(PAYMENT_OWED_HEADER, "true");
  return result;
}

/**
 * A PAYMENT-SIGNATURE whose authorization we already recorded (I14). Only an owed, settled payment
 * serves data again, for the same path it paid for, exactly once; anything else is a replay.
 * Nothing here calls the facilitator or charges.
 */
async function resend(c: Context<AppEnv>, next: () => Promise<void>, resource: PricedResource, payload: PaymentPayload, row: PaymentRow, d: AppDeps) {
  const sig = signatureOf(payload);
  const same = typeof sig === "string" && sig === signatureOf(row.payload) && row.endpoint === resource.id && row.resource === new URL(c.req.url).pathname;
  if (!same || !row.owedSince) {
    d.metrics.inc("x402_replay_rejected_total");
    return paymentRequired(c, resource, d, "payment_already_used");
  }
  c.header("X-Payment-Id", row.id);
  if (row.status === "verified") {
    c.header("Retry-After", "5");
    return c.json({ error: "settlement_pending", payment_id: row.id, detail: `still settling; resend the same PAYMENT-SIGNATURE once /v1/payments/${row.id} shows settled` }, 503);
  }
  if (row.status !== "settled") return paymentRequired(c, resource, d, `settlement_failed: ${row.error ?? row.status}`);

  const delivered = await deliver(c, next, row, d);
  if (delivered.kind === "busy") return delivered.response;
  d.metrics.inc("x402_owed_redeemed_total", { result: delivered.kind === "delivered" ? "delivered" : delivered.reason, resource: resource.id });
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
