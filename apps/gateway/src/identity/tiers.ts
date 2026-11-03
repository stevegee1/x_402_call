import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import type { ExposureCaps } from "../store/types";
import type { AgentRegistry } from "./erc8004";

/**
 * Buyer trust tiers from ERC-8004. Loosen-only by construction: every failure path (no header,
 * malformed id, wallet mismatch, registry error or timeout, weak reputation) lands on "unknown",
 * which is exactly the behaviour without ERC-8004. A tier raises only the per-payer exposure cap;
 * the global cap is never changed.
 *
 * Blocking is deliberately not a tier: a buyer can always omit X-Agent-Id, so an identity-based
 * block would be advisory. Wallet-level blocking stays with sanctions screening.
 */
export type Tier = "unknown" | "identified" | "trusted";

export const AGENT_ID_HEADER = "X-Agent-Id";

export type TierReason =
  | "no_agent_id"
  | "malformed_agent_id"
  | "other_registry"
  | "wallet_mismatch"
  | "lookup_failed"
  | "verified_wallet"
  | "reputation";

export interface TierDecision {
  tier: Tier;
  reason: TierReason;
  agentId?: bigint;
}

export interface TierPolicy {
  network: string;
  identityRegistry: Address;
  reviewers: readonly Address[];
  tag: string;
  minFeedback: number;
  minScore: number;
  timeoutMs: number;
  /** Per-payer caps by tier; the global cap is shared. */
  perPayerCapAtomic: Record<Tier, bigint>;
  totalCapAtomic: bigint;
}

/**
 * Accepts "123" or the ERC-8004 global form "eip155:<chainId>:<identityRegistry>:123".
 * A global id naming a different registry is not ours to verify.
 */
export function parseAgentId(raw: string, network: string, identityRegistry: Address): { agentId: bigint } | { error: "malformed_agent_id" | "other_registry" } {
  const v = raw.trim();
  if (/^\d{1,78}$/.test(v)) return { agentId: BigInt(v) };
  const m = /^(eip155:\d+):(0x[0-9a-fA-F]{40}):(\d{1,78})$/.exec(v);
  if (!m || !isAddress(m[2]!)) return { error: "malformed_agent_id" };
  if (m[1] !== network || getAddress(m[2]!) !== getAddress(identityRegistry)) return { error: "other_registry" };
  return { agentId: BigInt(m[3]!) };
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref())]);

interface CacheEntry {
  decision: TierDecision;
  expiresAt: number;
}

/** Resolves a payer's tier, caching outcomes (positive 5 min, negative 1 min, errors 10 s). */
export class TierResolver {
  private cache = new Map<string, CacheEntry>();
  private static readonly MAX_ENTRIES = 10_000;

  constructor(
    private readonly registry: AgentRegistry,
    readonly policy: TierPolicy,
    private readonly onLookup: (result: TierReason) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  capsFor(tier: Tier): ExposureCaps {
    return { totalAtomic: this.policy.totalCapAtomic, perPayerAtomic: this.policy.perPayerCapAtomic[tier] };
  }

  async resolve(payer: string, header: string | undefined): Promise<TierDecision> {
    if (!header) return { tier: "unknown", reason: "no_agent_id" };
    const parsed = parseAgentId(header, this.policy.network, this.policy.identityRegistry);
    if ("error" in parsed) return { tier: "unknown", reason: parsed.error };

    const key = `${parsed.agentId}:${payer.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.decision;

    let decision: TierDecision;
    let ttl: number;
    try {
      decision = await withTimeout(this.lookup(parsed.agentId, payer), this.policy.timeoutMs);
      ttl = decision.tier === "unknown" ? 60_000 : 300_000;
    } catch {
      decision = { tier: "unknown", reason: "lookup_failed", agentId: parsed.agentId };
      ttl = 10_000;
    }
    this.onLookup(decision.reason);
    if (this.cache.size >= TierResolver.MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { decision, expiresAt: this.now() + ttl });
    return decision;
  }

  private async lookup(agentId: bigint, payer: string): Promise<TierDecision> {
    const wallet = await this.registry.agentWallet(agentId);
    // Strict binding: the registry's verified wallet must be the address that signed this payment.
    // Unset (or cleared by a transfer) never matches.
    if (wallet === zeroAddress || wallet.toLowerCase() !== payer.toLowerCase()) return { tier: "unknown", reason: "wallet_mismatch", agentId };
    if (this.policy.reviewers.length === 0) return { tier: "identified", reason: "verified_wallet", agentId };
    const rep = await this.registry.reputation(agentId, this.policy.reviewers, this.policy.tag);
    const trusted = rep.count >= this.policy.minFeedback && rep.score >= this.policy.minScore;
    return trusted ? { tier: "trusted", reason: "reputation", agentId } : { tier: "identified", reason: "verified_wallet", agentId };
  }
}
