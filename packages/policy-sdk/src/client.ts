import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { LocalAccount } from "viem";
import { isUsdc, usdcAtomicToUsd } from "./assets";
import { BuyerBreakers } from "./breakers";
import { evaluateStatic, validatePolicy, type Decision, type DenyCode, type Policy } from "./policy";
import { SpendLog } from "./spend-log";

export interface PolicyEvent {
  ts: number;
  agentId: string;
  type: "denied" | "paid" | "credits_charged" | "owed_dropped";
  rail: "x402" | "credits";
  url: string;
  code?: DenyCode;
  reason?: string;
  amount?: number;
  currency?: "USD" | "GBP";
  status?: number;
  paymentId?: string;
  transaction?: string;
}

export class PolicyDeniedError extends Error {
  constructor(
    readonly code: DenyCode,
    reason: string,
  ) {
    super(`payment denied by policy (${code}): ${reason}`);
    this.name = "PolicyDeniedError";
  }
}

export interface PolicyClientOptions {
  policy: Policy;
  /** Wallet that signs x402 payments. Customer-owned: the SDK never transmits the key. */
  signer?: LocalAccount;
  /**
   * The signer's ERC-8004 agent id ("42" or "eip155:<chainId>:<registry>:42"), sent as X-Agent-Id
   * with x402 payments. Sellers that verify it against the registry may serve the agent faster.
   * It must be the agent whose verified wallet is `signer`, or sellers will ignore it.
   */
  agentId?: string;
  /** Fiat-credit API key, sent ONLY to the listed origins. */
  credits?: { apiKey: string; origins: string[] };
  spendLogPath?: string;
  /** Hosted control plane: decisions are batched and POSTed here (best effort). */
  report?: { url: string; apiKey: string };
  onEvent?: (e: PolicyEvent) => void;
  fetch?: typeof fetch;
  /**
   * When a paid x402 call answers "settlement pending" or "paid, data owed" (X-Payment-Owed), resend
   * the SAME signed payment rather than paying again: the seller delivers the data once, with no
   * second charge. attempts: resends after the first try (default 4; 0 turns it off). Each waits the
   * seller's Retry-After, capped at maxDelayMs (default 10 s).
   */
  owedResend?: { attempts?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void> };
}

/**
 * What a paid answer means for the signed payment behind it:
 *   retry: the seller has (or may have) the money and can deliver on a resend of the same signature
 *          soon (settling, another delivery in flight, a transient 5xx while owed);
 *   stuck: owed, but refused with a 4xx that a resend won't change (say the vessel left the area):
 *          only the seller's operator can make it right;
 *   done:  nothing is owed (delivered, refused before any charge, or failed and not charged).
 */
async function owedState(res: Response): Promise<"retry" | "stuck" | "done"> {
  if (res.headers.get("x-payment-owed") === "true") return res.status >= 500 || res.status === 409 ? "retry" : "stuck";
  if (res.status !== 503 && res.status !== 409) return "done";
  try {
    const error = ((await res.clone().json()) as { error?: unknown }).error;
    return error === "settlement_pending" || error === "redemption_in_progress" ? "retry" : "done";
  } catch {
    return "done";
  }
}

const retryAfterMs = (res: Response, maxMs: number) => {
  const s = Number(res.headers.get("retry-after"));
  return Math.min(maxMs, Number.isFinite(s) && s > 0 ? s * 1000 : 1000);
};

export interface PolicyClient {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  spendLog: SpendLog;
  breakers: BuyerBreakers;
  recentEvents: () => readonly PolicyEvent[];
  flush: () => Promise<void>;
}

const CREDITS_CHARGED_HEADER = "x-credits-charged-gbp-micros";

export function createPolicyClient(opts: PolicyClientOptions): PolicyClient {
  validatePolicy(opts.policy);
  const policy = opts.policy;
  const baseFetch = opts.fetch ?? globalThis.fetch;
  const spendLog = new SpendLog(opts.spendLogPath);
  const breakers = new BuyerBreakers(policy.breakers);
  const recent: PolicyEvent[] = [];
  let outbox: PolicyEvent[] = [];

  let http: x402HTTPClient | undefined;
  if (opts.signer) {
    const core = x402Client.fromConfig({
      schemes: policy.allowedNetworks.map((network) => ({ network: network as `${string}:${string}`, client: new ExactEvmScheme(opts.signer!) })),
      // Defence in depth: the library's own cap mirrors our policy max.
      spendControls: { maxAmountPerPayment: `$${policy.maxPricePerRequestUsd}` },
    });
    http = new x402HTTPClient(core);
  }

  const emit = (e: PolicyEvent) => {
    recent.push(e);
    if (recent.length > 500) recent.shift();
    if (opts.report) outbox.push(e);
    opts.onEvent?.(e);
  };

  const deny = (url: string, rail: PolicyEvent["rail"], d: Extract<Decision, { allow: false }>): never => {
    emit({ ts: Date.now(), agentId: policy.agentId, type: "denied", rail, url, code: d.code, reason: d.reason });
    throw new PolicyDeniedError(d.code, d.reason);
  };

  async function viaCredits(req: Request, url: URL): Promise<Response> {
    const spent = spendLog.spentToday("GBP");
    if (policy.dailyBudgetGbp !== undefined && spent >= policy.dailyBudgetGbp)
      deny(url.href, "credits", { allow: false, code: "daily_budget_exceeded", reason: `daily GBP budget £${policy.dailyBudgetGbp} reached` });
    const b = breakers.check(url.href, url.origin, 0);
    if (!b.allow) deny(url.href, "credits", b);

    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${opts.credits!.apiKey}`);
    const res = await baseFetch(new Request(req, { headers }));
    const chargedMicros = Number(res.headers.get(CREDITS_CHARGED_HEADER) ?? 0);
    if (chargedMicros > 0) {
      const amount = chargedMicros / 1_000_000;
      breakers.recordPayment(url.href, 0);
      spendLog.add({ ts: Date.now(), agentId: policy.agentId, costCentre: policy.costCentre, rail: "credits", url: url.href, origin: url.origin, amount, currency: "GBP", status: res.status });
      emit({ ts: Date.now(), agentId: policy.agentId, type: "credits_charged", rail: "credits", url: url.href, amount, currency: "GBP", status: res.status });
    }
    breakers.recordOutcome(url.origin, res.status < 500);
    return res;
  }

  const resend = {
    attempts: opts.owedResend?.attempts ?? 4,
    maxDelayMs: opts.owedResend?.maxDelayMs ?? 10_000,
    sleep: opts.owedResend?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  /**
   * Signed payments the seller still owes data for, oldest first per request: the next call to the
   * same URL resends the oldest instead of paying again. Bounded; a debt dropped for room is reported.
   */
  const owed = new Map<string, Headers[]>();
  let owedCount = 0;
  const MAX_OWED = 100;
  const owedKey = (req: Request) => `${req.method} ${req.url}`;

  const dropOwed = (key: string, headers: Headers, reason: string) => {
    const q = owed.get(key);
    const i = q?.indexOf(headers) ?? -1;
    if (!q || i < 0) return;
    q.splice(i, 1);
    owedCount--;
    if (q.length === 0) owed.delete(key);
    emit({ ts: Date.now(), agentId: policy.agentId, type: "owed_dropped", rail: "x402", url: key.slice(key.indexOf(" ") + 1), reason });
  };
  const forget = (key: string, headers: Headers) => {
    const q = owed.get(key);
    const i = q?.indexOf(headers) ?? -1;
    if (!q || i < 0) return;
    q.splice(i, 1);
    owedCount--;
    if (q.length === 0) owed.delete(key);
  };
  const remember = (key: string, headers: Headers) => {
    const q = owed.get(key) ?? [];
    if (q.includes(headers)) return;
    q.push(headers);
    owed.set(key, q);
    owedCount++;
    while (owedCount > MAX_OWED) {
      const [oldestKey, oldestQ] = owed.entries().next().value!;
      dropOwed(oldestKey, oldestQ[0]!, "too_many_owed_payments");
    }
  };

  /** Resends one signed payment while the seller says it is coming. Never throws: keeps the last answer. */
  async function resendOwed(req: Request, headers: Headers, res: Response): Promise<Response> {
    for (let i = 0; i < resend.attempts && (await owedState(res)) === "retry"; i++) {
      await resend.sleep(retryAfterMs(res, resend.maxDelayMs));
      try {
        const next = await baseFetch(new Request(req, { headers }));
        await res.body?.cancel().catch(() => {});
        res = next;
      } catch {
        break; // network trouble: the debt is remembered and retried on the next call
      }
    }
    return res;
  }

  /** After any x402 answer: remember or forget the signature, so the next call can't pay twice. */
  async function settleOwed(req: Request, headers: Headers, res: Response) {
    const key = owedKey(req);
    const state = await owedState(res);
    if (state === "retry") remember(key, headers);
    else if (state === "stuck") {
      remember(key, headers);
      dropOwed(key, headers, `seller owes data but refused with ${res.status}; contact the seller with payment ${res.headers.get("x-payment-id") ?? "?"}`);
    } else forget(key, headers);
  }

  async function viaX402(req: Request, url: URL): Promise<Response> {
    // Payments this request already made but weren't delivered: resend them, oldest first, before
    // ever signing a new one.
    for (let pending = req.method === "GET" ? owed.get(owedKey(req))?.[0] : undefined; pending; pending = owed.get(owedKey(req))?.[0]) {
      // A network error here propagates and the debt stays remembered for the next call.
      let res = await baseFetch(new Request(req, { headers: pending }));
      res = await resendOwed(req, pending, res);
      const state = await owedState(res);
      await settleOwed(req, pending, res);
      breakers.recordOutcome(url.origin, res.status < 400);
      // Delivered, still coming, or stuck (the seller owes it but can't deliver: reported via
      // owed_dropped): the answer belongs to a payment already made, so return it. Only a refusal
      // that owes nothing (a replay of a delivered payment, or one never charged) moves on.
      if (res.status < 400 || state !== "done") {
        emit({ ts: Date.now(), agentId: policy.agentId, type: "paid", rail: "x402", url: url.href, status: res.status, paymentId: res.headers.get("x-payment-id") ?? undefined });
        return res;
      }
      forget(owedKey(req), pending);
      await res.body?.cancel().catch(() => {});
    }

    const first = await baseFetch(req.clone());
    if (first.status !== 402 || !http) return first;

    let body: unknown;
    try {
      body = await first.clone().json();
    } catch {
      body = undefined;
    }
    const paymentRequired: PaymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n), body);

    const candidates = paymentRequired.accepts
      .filter((r) => policy.allowedNetworks.includes(r.network) && isUsdc(r.network, r.asset))
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
    const req0 = candidates[0];
    if (!req0) {
      const any = paymentRequired.accepts[0];
      deny(url.href, "x402", {
        allow: false,
        code: any && !policy.allowedNetworks.includes(any.network) ? "network_not_allowed" : "asset_not_allowed",
        reason: "seller offers no USDC payment option on an allowed network",
      });
    }
    const requirement = req0!;
    const priceUsd = usdcAtomicToUsd(requirement.amount);

    const decision = evaluateStatic(policy, {
      url: url.href,
      origin: url.origin,
      network: requirement.network,
      assetIsUsdc: true,
      payTo: requirement.payTo,
      priceUsd,
      spentTodayUsd: spendLog.spentToday("USD"),
    });
    if (!decision.allow) deny(url.href, "x402", decision);
    const b = breakers.check(url.href, url.origin, priceUsd);
    if (!b.allow) deny(url.href, "x402", b);

    // Sign exactly the requirement the policy approved (no shared state: safe under concurrency).
    const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [requirement] });
    const headers = new Headers(req.headers);
    for (const [k, v] of Object.entries(http.encodePaymentSignatureHeader(payload))) headers.set(k, v);
    if (opts.agentId) headers.set("X-Agent-Id", opts.agentId);

    // Count the spend as soon as we sign: conservative for budgets even if the seller later fails.
    breakers.recordPayment(url.href, priceUsd);
    let paid: Response;
    try {
      paid = await baseFetch(new Request(req, { headers }));
    } catch (e) {
      // The request died in flight (timeout, reset, abort) after we signed: the seller may well
      // have settled it. Count the spend and keep the signature, so the next call resends it.
      if (req.method === "GET") remember(owedKey(req), headers);
      spendLog.add({ ts: Date.now(), agentId: policy.agentId, costCentre: policy.costCentre, rail: "x402", url: url.href, origin: url.origin, amount: priceUsd, currency: "USD", network: requirement.network, payTo: requirement.payTo, status: 0 });
      breakers.recordOutcome(url.origin, false);
      throw e;
    }
    // Same signature, same payment: a resend can never be charged twice (the nonce is single-use).
    // Only GET: sellers deliver owed data only to a GET, and a consumed body can't be sent again.
    if (req.method === "GET") {
      paid = await resendOwed(req, headers, paid);
      await settleOwed(req, headers, paid);
    }
    breakers.recordOutcome(url.origin, paid.status < 400);

    let transaction: string | undefined;
    try {
      transaction = http.getPaymentSettleResponse((n) => paid.headers.get(n)).transaction || undefined;
    } catch {
      transaction = undefined; // async settlement: seller returns a payment id instead
    }
    const paymentId = paid.headers.get("x-payment-id") ?? undefined;
    spendLog.add({
      ts: Date.now(),
      agentId: policy.agentId,
      costCentre: policy.costCentre,
      rail: "x402",
      url: url.href,
      origin: url.origin,
      amount: priceUsd,
      currency: "USD",
      network: requirement.network,
      payTo: requirement.payTo,
      status: paid.status,
      paymentId,
      transaction,
    });
    emit({ ts: Date.now(), agentId: policy.agentId, type: "paid", rail: "x402", url: url.href, amount: priceUsd, currency: "USD", status: paid.status, paymentId, transaction });
    return paid;
  }

  async function flush() {
    if (!opts.report || outbox.length === 0) return;
    const batch = outbox;
    outbox = [];
    try {
      await baseFetch(opts.report.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.report.apiKey}` },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      outbox = batch.concat(outbox).slice(-1_000); // retry next flush; bounded
    }
  }
  if (opts.report) setInterval(() => void flush(), 2_000).unref();

  return {
    fetch: async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (opts.credits?.origins.includes(url.origin)) return viaCredits(req, url);
      return viaX402(req, url);
    },
    spendLog,
    breakers,
    recentEvents: () => recent,
    flush,
  };
}
