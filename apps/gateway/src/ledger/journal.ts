import { createHash, randomUUID } from "node:crypto";
import { productOfResource } from "../platform/catalog";
import { splitInclusive } from "./vat";

/**
 * Append-only, double-entry, hash-chained ledger. All amounts are integer GBP micros (1 GBP = 1e6),
 * the functional currency for HMRC. USDC amounts and FX quotes are kept in the memo.
 */
export const ACCOUNTS = {
  usdcWallet: "asset:usdc_wallet",
  stripeClearing: "asset:stripe_clearing",
  bankTransfer: "asset:bank_transfer",
  creditsLiability: "liability:customer_credits",
  /** x402 sessions: paid for, not yet used. Released to product revenue as reads spend it. */
  sessionPrepaid: "liability:session_prepaid",
  /** Session balances that expired unused (breakage). Accountant sign-off needed before mainnet. */
  sessionBreakage: "revenue:session_breakage",
  vatOutput: "liability:vat_output",
} as const;

export const REVENUE_PREFIX = "revenue:";

/** Revenue is booked per product: `revenue:<productId>`, derived from the namespaced resource id. */
export function revenueAccount(resourceId: string): string {
  return `${REVENUE_PREFIX}${productOfResource(resourceId)}`;
}

export type JournalKind = "x402_settlement" | "credits_topup" | "credits_usage" | "credits_refund" | "session_usage" | "session_breakage";

/** Resources whose x402 payment buys a session (a prepayment), not data. */
export const SESSION_RESOURCE_PREFIX = "sessions.";
export const isSessionPurchase = (resourceId: string) => resourceId.startsWith(SESSION_RESOURCE_PREFIX);

export interface JournalLine {
  account: string;
  debit: number;
  credit: number;
}

export interface JournalInput {
  id: string;
  kind: JournalKind;
  ref: string;
  occurredAt: string;
  lines: JournalLine[];
  memo: Record<string, unknown>;
}

export interface JournalEntry extends JournalInput {
  seq: number;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);

export function assertBalanced(lines: JournalLine[]): void {
  let d = 0;
  let c = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit) || l.debit < 0 || l.credit < 0)
      throw new Error(`invalid amounts on ${l.account}`);
    d += l.debit;
    c += l.credit;
  }
  if (d !== c) throw new Error(`unbalanced journal: debits ${d} != credits ${c}`);
  if (d === 0) throw new Error("empty journal");
}

/**
 * Returns the journal with occurredAt in canonical form (UTC, millisecond ISO-8601). Stores call this
 * before hashing: Postgres returns timestamptz in this form, so hashing any other spelling of the
 * same instant ("…T10:00:00Z", "+01:00" offsets) would break chain verification after a round trip.
 */
export function normalizeJournal(j: JournalInput): JournalInput {
  const t = new Date(j.occurredAt);
  if (Number.isNaN(t.getTime())) throw new Error(`invalid journal occurredAt: ${JSON.stringify(j.occurredAt)}`);
  return { ...j, occurredAt: t.toISOString() };
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function computeHash(prevHash: string, j: JournalInput): string {
  return createHash("sha256").update(prevHash).update(canonicalJson(j)).digest("hex");
}

export function verifyChain(entries: JournalEntry[]): { ok: true } | { ok: false; brokenAtSeq: number } {
  let prev = GENESIS_HASH;
  for (const e of entries) {
    const { seq: _s, prevHash, hash, ...input } = e;
    if (prevHash !== prev || computeHash(prev, input) !== hash) return { ok: false, brokenAtSeq: e.seq };
    prev = hash;
  }
  return { ok: true };
}

const L = (account: string, debit: number, credit: number): JournalLine => ({ account, debit, credit });

export function x402SettlementJournal(p: {
  paymentId: string;
  amountAtomic: bigint;
  fxRate: number;
  fxSource: string;
  transaction: string | null;
  payer: string;
  network: string;
  /** Namespaced resource id, e.g. "maritime.vessels". */
  endpoint: string;
  occurredAt: string;
}): JournalInput {
  // A session purchase is a prepayment: VAT is due now (the tax point is the payment), and the net
  // is a liability until reads spend it. Anything else is revenue for the product sold.
  const revenue = isSessionPurchase(p.endpoint) ? ACCOUNTS.sessionPrepaid : revenueAccount(p.endpoint);
  const { netMicros, vatMicros, grossMicros } = x402Gbp(p.amountAtomic, p.fxRate);
  return {
    id: randomUUID(),
    kind: "x402_settlement",
    ref: p.paymentId,
    occurredAt: p.occurredAt,
    lines: [L(ACCOUNTS.usdcWallet, grossMicros, 0), L(revenue, 0, netMicros), L(ACCOUNTS.vatOutput, 0, vatMicros)],
    memo: {
      usdc_atomic: p.amountAtomic.toString(),
      fx_usdc_gbp: p.fxRate,
      fx_source: p.fxSource,
      tx: p.transaction,
      payer: p.payer,
      network: p.network,
      endpoint: p.endpoint,
      vat_treatment: "uk_standard_inclusive",
    },
  };
}

/** USDC atomic (6 dp) is numerically USD micros; GBP micros at the quote used at verify time, VAT-inclusive. */
export function x402Gbp(amountAtomic: bigint, fxRate: number): { grossMicros: number; netMicros: number; vatMicros: number } {
  const grossMicros = Math.round(Number(amountAtomic) * fxRate);
  return { grossMicros, ...splitInclusive(grossMicros) };
}

/**
 * Releases the net GBP liability of a session in proportion to what was spent: after a report, the
 * total released is floor(net × spent / amount), so rounding never drifts over many reports. This
 * report's share is split across the resources that spent it.
 */
export function sessionRelease(p: {
  netGbpMicros: number;
  amountAtomic: bigint;
  spentBeforeAtomic: bigint;
  releasedBeforeMicros: number;
  byResource: ReadonlyMap<string, bigint>;
}): { releasedAfterMicros: number; lines: Array<{ resourceId: string; micros: number }> } {
  let batch = 0n;
  for (const v of p.byResource.values()) batch += v;
  const spentAfter = p.spentBeforeAtomic + batch;
  const target = Number((BigInt(p.netGbpMicros) * spentAfter) / p.amountAtomic);
  const delta = Math.max(0, target - p.releasedBeforeMicros);
  if (batch === 0n || delta === 0) return { releasedAfterMicros: p.releasedBeforeMicros + delta, lines: [] };
  const entries = [...p.byResource.entries()].filter(([, v]) => v > 0n).sort(([a], [b]) => a.localeCompare(b));
  const lines = entries.map(([resourceId, v]) => ({ resourceId, micros: Number((BigInt(delta) * v) / batch) }));
  // Integer division leaves a remainder; give it to the largest spender so the lines sum exactly.
  const rest = delta - lines.reduce((n, l) => n + l.micros, 0);
  let largest = 0;
  for (let i = 1; i < entries.length; i++) if (entries[i]![1] > entries[largest]![1]) largest = i;
  lines[largest]!.micros += rest;
  return { releasedAfterMicros: p.releasedBeforeMicros + delta, lines: lines.filter((l) => l.micros > 0) };
}

export function sessionUsageJournal(p: { sessionId: string; lines: Array<{ resourceId: string; micros: number }>; spentAtomic: Record<string, string>; occurredAt: string }): JournalInput {
  const total = p.lines.reduce((n, l) => n + l.micros, 0);
  return {
    id: randomUUID(),
    kind: "session_usage",
    ref: p.sessionId,
    occurredAt: p.occurredAt,
    lines: [L(ACCOUNTS.sessionPrepaid, total, 0), ...p.lines.map((l) => L(revenueAccount(l.resourceId), 0, l.micros))],
    memo: { session_id: p.sessionId, usdc_atomic_by_resource: p.spentAtomic },
  };
}

export function sessionBreakageJournal(p: { sessionId: string; micros: number; unusedAtomic: string; occurredAt: string }): JournalInput {
  return {
    id: randomUUID(),
    kind: "session_breakage",
    ref: p.sessionId,
    occurredAt: p.occurredAt,
    lines: [L(ACCOUNTS.sessionPrepaid, p.micros, 0), L(ACCOUNTS.sessionBreakage, 0, p.micros)],
    memo: { session_id: p.sessionId, unused_usdc_atomic: p.unusedAtomic },
  };
}

export function creditsTopUpJournal(p: {
  accountId: string;
  netMicros: number;
  vatMicros: number;
  vatTreatment: string;
  method: "stripe" | "bank_transfer";
  ref: string;
  occurredAt: string;
}): JournalInput {
  const clearing = p.method === "stripe" ? ACCOUNTS.stripeClearing : ACCOUNTS.bankTransfer;
  const lines = [L(clearing, p.netMicros + p.vatMicros, 0), L(ACCOUNTS.creditsLiability, 0, p.netMicros)];
  if (p.vatMicros > 0) lines.push(L(ACCOUNTS.vatOutput, 0, p.vatMicros));
  return {
    id: randomUUID(),
    kind: "credits_topup",
    ref: p.ref,
    occurredAt: p.occurredAt,
    lines,
    memo: { account_id: p.accountId, vat_treatment: p.vatTreatment, method: p.method },
  };
}

export function creditsUsageJournal(p: { accountId: string; micros: number; endpoint: string; ref: string; occurredAt: string; refund?: boolean }): JournalInput {
  const revenue = revenueAccount(p.endpoint);
  const lines = p.refund
    ? [L(revenue, p.micros, 0), L(ACCOUNTS.creditsLiability, 0, p.micros)]
    : [L(ACCOUNTS.creditsLiability, p.micros, 0), L(revenue, 0, p.micros)];
  return {
    id: randomUUID(),
    kind: p.refund ? "credits_refund" : "credits_usage",
    ref: p.ref,
    occurredAt: p.occurredAt,
    lines,
    memo: { account_id: p.accountId, endpoint: p.endpoint },
  };
}
