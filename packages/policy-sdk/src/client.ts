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
  type: "denied" | "paid" | "credits_charged";
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
  /** Fiat-credit API key, sent ONLY to the listed origins. */
  credits?: { apiKey: string; origins: string[] };
  spendLogPath?: string;
  /** Hosted control plane: decisions are batched and POSTed here (best effort). */
  report?: { url: string; apiKey: string };
  onEvent?: (e: PolicyEvent) => void;
  fetch?: typeof fetch;
}

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

  async function viaX402(req: Request, url: URL): Promise<Response> {
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

    // Count the spend as soon as we sign: conservative for budgets even if the seller later fails.
    breakers.recordPayment(url.href, priceUsd);
    const paid = await baseFetch(new Request(req, { headers }));
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
