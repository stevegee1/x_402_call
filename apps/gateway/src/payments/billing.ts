import { randomUUID } from "node:crypto";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import type { Context, MiddlewareHandler } from "hono";
import { isMainnet } from "../config";
import type { AppDeps, AppEnv } from "../context";
import { looksLikeApiKey } from "../credits/keys";
import { creditsUsageJournal } from "../ledger/journal";
import type { PricedResource, Precheck, Product } from "../platform/product";
import { FacilitatorUnavailableError } from "./facilitator";

/** Async mode: give the request path this long to serve or cancel before the worker may settle. */
const ASYNC_SETTLE_DELAY_MS = 2_000;
/** If the authorization expires sooner than this, settle inline rather than queueing. */
const MIN_ASYNC_VALIDITY_MS = 30_000;

export const CREDITS_CHARGED_HEADER = "X-Credits-Charged-Gbp-Micros";
export const CREDITS_BALANCE_HEADER = "X-Credits-Balance-Gbp-Micros";

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
    c.set("resolution", resolved);
    const rejected = precheck?.(c, resolved.state);
    if (rejected) return rejected;

    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer mk_")) return chargeCredits(c, next, resource, auth.slice(7), d);

    const sig = c.req.header("payment-signature");
    if (sig) return chargeX402(c, next, resource, sig, d);

    if (c.req.header("x-payment")) return paymentRequired(c, resource, d, "x402_v1_not_supported: use PAYMENT-SIGNATURE (x402 v2)");
    return paymentRequired(c, resource, d);
  };
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
  const sync =
    d.cfg.SETTLEMENT_MODE === "sync" || d.exposure.wouldExceed(payer, amount) || validBefore.getTime() - Date.now() < MIN_ASYNC_VALIDITY_MS;

  const fx = await d.fx.usdcGbp();
  const id = randomUUID();
  const inserted = await d.store.insertPayment({
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
    // Sync: keep the worker away while we settle inline. Async: let the handler finish first.
    nextAttemptAt: new Date(Date.now() + (sync ? 120_000 : ASYNC_SETTLE_DELAY_MS)),
  });
  if (inserted === "duplicate") {
    d.metrics.inc("x402_replay_rejected_total");
    return paymentRequired(c, resource, d, "payment_already_used");
  }

  if (sync) {
    const row = (await d.store.getPayment(id))!;
    const outcome = await d.settler.settleNow(row);
    if (!outcome.ok) {
      if (!outcome.final) return c.json({ error: "settlement_pending", payment_id: id, detail: "settlement did not complete; retry shortly" }, 503);
      return paymentRequired(c, resource, d, `settlement_failed: ${outcome.reason}`);
    }
    await next();
    if (outcome.response) c.res.headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(outcome.response));
    c.res.headers.set("X-Payment-Id", id);
    c.res.headers.set("X-Settlement", "settled");
  } else {
    d.exposure.add(payer, amount);
    await next();
    if (c.res.status >= 400) {
      await d.store.cancelPayment(id, `handler_status_${c.res.status}`);
      d.exposure.release(payer, amount);
      return;
    }
    c.res.headers.set("X-Payment-Id", id);
    c.res.headers.set("X-Settlement", "pending");
  }
  d.metrics.inc("paid_requests_total", { rail: "x402", resource: resource.id, mode: sync ? "sync" : "async" });
}
