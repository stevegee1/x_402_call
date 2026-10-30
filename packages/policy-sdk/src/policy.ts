/**
 * Declarative spend policy. Evaluated before any payment is signed.
 * MVP uses a JSON policy with a fixed rule set; Cedar is the planned policy language (ADR D4).
 */
export interface Policy {
  agentId: string;
  costCentre?: string;
  /** Hard ceiling on any single payment. */
  maxPricePerRequestUsd: number;
  /** Rolling UTC-day budget across all sellers (x402). */
  dailyBudgetUsd: number;
  /** Daily budget for fiat-credit calls (GBP). */
  dailyBudgetGbp?: number;
  /** CAIP-2 networks the agent may pay on. */
  allowedNetworks: string[];
  /** If set, only these seller origins may be paid (e.g. "https://api.example.com"). */
  allowedOrigins?: string[];
  /** If set, only these payTo addresses may receive funds. */
  allowedPayTo?: string[];
  breakers: {
    /** Max payments per window across all sellers before the velocity breaker opens. */
    velocity: { maxPayments: number; windowMs: number };
    /** Max payments to the same URL per window (loop detection). */
    perUrl: { maxPayments: number; windowMs: number };
    /** Consecutive paid-but-failed responses from one origin before it is blocked. */
    payAndFailThreshold: number;
    /** Price increase vs. last seen for the same URL that requires re-approval (0.5 = +50%). */
    priceIncreaseTolerance: number;
    cooldownMs: number;
  };
}

export type DenyCode =
  | "network_not_allowed"
  | "asset_not_allowed"
  | "origin_not_allowed"
  | "payto_not_allowed"
  | "price_above_max"
  | "daily_budget_exceeded"
  | "velocity_breaker_open"
  | "loop_detected"
  | "seller_breaker_open"
  | "price_spike";

export type Decision = { allow: true } | { allow: false; code: DenyCode; reason: string };

export interface PaymentContext {
  url: string;
  origin: string;
  network: string;
  assetIsUsdc: boolean;
  payTo: string;
  priceUsd: number;
  spentTodayUsd: number;
}

export const DEFAULT_BREAKERS: Policy["breakers"] = {
  velocity: { maxPayments: 30, windowMs: 60_000 },
  perUrl: { maxPayments: 10, windowMs: 60_000 },
  payAndFailThreshold: 3,
  priceIncreaseTolerance: 0.5,
  cooldownMs: 5 * 60_000,
};

const deny = (code: DenyCode, reason: string): Decision => ({ allow: false, code, reason });

/** Static rules only. Stateful breakers live in breakers.ts. */
export function evaluateStatic(p: Policy, c: PaymentContext): Decision {
  if (!p.allowedNetworks.includes(c.network)) return deny("network_not_allowed", `network ${c.network} not in policy`);
  if (!c.assetIsUsdc) return deny("asset_not_allowed", "only USDC payments are permitted");
  if (p.allowedOrigins && !p.allowedOrigins.includes(c.origin)) return deny("origin_not_allowed", `seller ${c.origin} not allowlisted`);
  if (p.allowedPayTo && !p.allowedPayTo.map((a) => a.toLowerCase()).includes(c.payTo.toLowerCase()))
    return deny("payto_not_allowed", `payTo ${c.payTo} not allowlisted`);
  if (c.priceUsd > p.maxPricePerRequestUsd)
    return deny("price_above_max", `price $${c.priceUsd} exceeds max $${p.maxPricePerRequestUsd}`);
  if (c.spentTodayUsd + c.priceUsd > p.dailyBudgetUsd)
    return deny("daily_budget_exceeded", `daily budget $${p.dailyBudgetUsd} would be exceeded (spent $${c.spentTodayUsd.toFixed(3)})`);
  return { allow: true };
}

export function validatePolicy(p: Policy): void {
  if (!p.agentId) throw new Error("policy.agentId is required");
  if (!(p.maxPricePerRequestUsd > 0)) throw new Error("policy.maxPricePerRequestUsd must be > 0");
  if (!(p.dailyBudgetUsd >= 0)) throw new Error("policy.dailyBudgetUsd must be >= 0");
  if (!p.allowedNetworks?.length) throw new Error("policy.allowedNetworks must not be empty");
}
