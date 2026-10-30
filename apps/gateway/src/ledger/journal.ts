import { createHash, randomUUID } from "node:crypto";
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
  vatOutput: "liability:vat_output",
  revenueData: "revenue:data_api",
} as const;

export type JournalKind = "x402_settlement" | "credits_topup" | "credits_usage" | "credits_refund";

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
  endpoint: string;
  occurredAt: string;
}): JournalInput {
  // USDC atomic (6dp) is numerically USD micros; convert to GBP micros at the quote used at verify time.
  const grossMicros = Math.round(Number(p.amountAtomic) * p.fxRate);
  const { netMicros, vatMicros } = splitInclusive(grossMicros);
  return {
    id: randomUUID(),
    kind: "x402_settlement",
    ref: p.paymentId,
    occurredAt: p.occurredAt,
    lines: [L(ACCOUNTS.usdcWallet, grossMicros, 0), L(ACCOUNTS.revenueData, 0, netMicros), L(ACCOUNTS.vatOutput, 0, vatMicros)],
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
  const lines = p.refund
    ? [L(ACCOUNTS.revenueData, p.micros, 0), L(ACCOUNTS.creditsLiability, 0, p.micros)]
    : [L(ACCOUNTS.creditsLiability, p.micros, 0), L(ACCOUNTS.revenueData, 0, p.micros)];
  return {
    id: randomUUID(),
    kind: p.refund ? "credits_refund" : "credits_usage",
    ref: p.ref,
    occurredAt: p.occurredAt,
    lines,
    memo: { account_id: p.accountId, endpoint: p.endpoint },
  };
}
