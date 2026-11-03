/**
 * Ledger <-> chain reconciliation for the x402 rail. Every check runs in both directions:
 *  - each USDC transfer into payTo is a settled payment with a matching journal, and
 *  - each settled payment is a transfer on chain, for the same payer, nonce and amount.
 * A payment the ledger cancelled or failed must never have moved money (I5), and payTo's balance
 * must be explained entirely by recorded settlements.
 */

export interface LedgerPayment {
  id: string;
  status: "verified" | "settled" | "failed" | "cancelled";
  payer: string;
  nonce: string;
  amountAtomic: bigint;
  tx: string | null;
  /** Epoch ms. Optional: only used to give in-flight payments a grace period. */
  createdAt?: number;
}

export interface ChainTransfer {
  tx: string;
  from: string;
  value: bigint;
  /** EIP-3009 nonce from the AuthorizationUsed event in the same transaction; null for a plain transfer. */
  nonce: string | null;
}

export interface JournalSettlement {
  ref: string;
  usdcAtomic: bigint;
  grossGbpMicros: number;
  fx: number;
  tx: string | null;
}

export interface ReconcileInput {
  payments: LedgerPayment[];
  transfers: ChainTransfer[];
  journal: JournalSettlement[];
  payToBalance: bigint;
  ledgerChainOk: boolean;
  /**
   * Payments still verified (unsettled) younger than this are normal in a live system and are not
   * reported. Default 0: every pending payment is a problem (e.g. a quiescent test stack).
   */
  pendingGraceMs?: number;
  now?: number;
}

export type Problem =
  | { code: "pending_payments"; ids: string[] }
  | { code: "ledger_chain_broken" }
  | { code: "unrecorded_onchain_transfer"; tx: string; from: string; value: string; nonce: string | null }
  | { code: "onchain_but_not_settled"; id: string; status: string; tx: string }
  | { code: "settled_without_onchain_transfer"; id: string }
  | { code: "amount_mismatch"; id: string; ledger: string; chain: string }
  | { code: "tx_mismatch"; id: string; ledger: string; chain: string }
  | { code: "journal_missing"; id: string }
  | { code: "journal_duplicate"; id: string; count: number }
  | { code: "journal_for_unsettled_payment"; ref: string }
  | { code: "journal_amount_mismatch"; id: string; journal: string; payment: string }
  | { code: "journal_gbp_mismatch"; id: string; journal: number; expected: number }
  | { code: "journal_tx_mismatch"; id: string; journal: string | null; payment: string | null }
  | { code: "balance_mismatch"; balance: string; transfers: string; settled: string };

export interface ReconcileReport {
  ok: boolean;
  problems: Problem[];
  totals: { settledCount: number; settledAtomic: bigint; payToBalance: bigint; transferCount: number };
}

const key = (payer: string, nonce: string) => `${payer.toLowerCase()}:${nonce.toLowerCase()}`;
const eqHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function reconcile(input: ReconcileInput): ReconcileReport {
  const problems: Problem[] = [];

  const now = input.now ?? Date.now();
  const grace = input.pendingGraceMs ?? 0;
  const inFlight = (p: LedgerPayment) => p.status === "verified" && grace > 0 && p.createdAt !== undefined && now - p.createdAt < grace;
  const pending = input.payments.filter((p) => p.status === "verified" && !inFlight(p));
  if (pending.length) problems.push({ code: "pending_payments", ids: pending.map((p) => p.id) });
  if (!input.ledgerChainOk) problems.push({ code: "ledger_chain_broken" });

  const byAuth = new Map(input.payments.map((p) => [key(p.payer, p.nonce), p]));
  const matched = new Set<string>();
  let inFlightOnChain = 0n;
  for (const t of input.transfers) {
    const p = t.nonce ? byAuth.get(key(t.from, t.nonce)) : undefined;
    if (!p) {
      problems.push({ code: "unrecorded_onchain_transfer", tx: t.tx, from: t.from, value: t.value.toString(), nonce: t.nonce });
      continue;
    }
    matched.add(p.id);
    if (p.status !== "settled") {
      if (inFlight(p)) {
        inFlightOnChain += t.value; // on chain, ledger catching up: the next run decides
        continue;
      }
      problems.push({ code: "onchain_but_not_settled", id: p.id, status: p.status, tx: t.tx });
      continue;
    }
    if (p.amountAtomic !== t.value) problems.push({ code: "amount_mismatch", id: p.id, ledger: p.amountAtomic.toString(), chain: t.value.toString() });
    // A null tx is legitimate: the settler resolved an indeterminate settle by reading the nonce state.
    if (p.tx && !eqHex(p.tx, t.tx)) problems.push({ code: "tx_mismatch", id: p.id, ledger: p.tx, chain: t.tx });
  }

  const settled = input.payments.filter((p) => p.status === "settled");
  for (const p of settled) if (!matched.has(p.id)) problems.push({ code: "settled_without_onchain_transfer", id: p.id });

  const journals = new Map<string, JournalSettlement[]>();
  for (const j of input.journal) journals.set(j.ref, [...(journals.get(j.ref) ?? []), j]);
  const settledIds = new Set(settled.map((p) => p.id));
  for (const ref of journals.keys()) if (!settledIds.has(ref)) problems.push({ code: "journal_for_unsettled_payment", ref });
  for (const p of settled) {
    const js = journals.get(p.id) ?? [];
    if (js.length === 0) {
      problems.push({ code: "journal_missing", id: p.id });
      continue;
    }
    if (js.length > 1) problems.push({ code: "journal_duplicate", id: p.id, count: js.length });
    const j = js[0]!;
    if (j.usdcAtomic !== p.amountAtomic) problems.push({ code: "journal_amount_mismatch", id: p.id, journal: j.usdcAtomic.toString(), payment: p.amountAtomic.toString() });
    const expected = Math.round(Number(p.amountAtomic) * j.fx);
    if (j.grossGbpMicros !== expected) problems.push({ code: "journal_gbp_mismatch", id: p.id, journal: j.grossGbpMicros, expected });
    if ((j.tx ?? null)?.toLowerCase() !== (p.tx ?? null)?.toLowerCase()) problems.push({ code: "journal_tx_mismatch", id: p.id, journal: j.tx, payment: p.tx });
  }

  const transferSum = input.transfers.reduce((s, t) => s + t.value, 0n);
  const settledAtomic = settled.reduce((s, p) => s + p.amountAtomic, 0n);
  if (input.payToBalance !== transferSum || transferSum !== settledAtomic + inFlightOnChain) {
    problems.push({ code: "balance_mismatch", balance: input.payToBalance.toString(), transfers: transferSum.toString(), settled: settledAtomic.toString() });
  }

  return {
    ok: problems.length === 0,
    problems,
    totals: { settledCount: settled.length, settledAtomic, payToBalance: input.payToBalance, transferCount: input.transfers.length },
  };
}
