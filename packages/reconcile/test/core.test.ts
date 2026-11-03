import { describe, expect, it } from "vitest";
import { reconcile, type ChainTransfer, type JournalSettlement, type LedgerPayment, type ReconcileInput } from "../src/core";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const n = (i: number) => `0x${i.toString(16).padStart(64, "0")}`;
const tx = (i: number) => `0x${(1000 + i).toString(16).padStart(64, "0")}`;

const payment = (i: number, over: Partial<LedgerPayment> = {}): LedgerPayment => ({
  id: `p${i}`,
  status: "settled",
  payer: A,
  nonce: n(i),
  amountAtomic: 33_000n,
  tx: tx(i),
  ...over,
});
const transfer = (i: number, over: Partial<ChainTransfer> = {}): ChainTransfer => ({ tx: tx(i), from: A, value: 33_000n, nonce: n(i), ...over });
const journal = (i: number, over: Partial<JournalSettlement> = {}): JournalSettlement => ({
  ref: `p${i}`,
  usdcAtomic: 33_000n,
  grossGbpMicros: 26_400,
  fx: 0.8,
  tx: tx(i),
  ...over,
});

/** Two settled payments plus one cancelled one, all consistent. */
function clean(): ReconcileInput {
  return {
    payments: [payment(1), payment(2, { payer: B, amountAtomic: 66_000n }), payment(3, { status: "cancelled", tx: null })],
    transfers: [transfer(1), transfer(2, { from: B, value: 66_000n })],
    journal: [journal(1), journal(2, { usdcAtomic: 66_000n, grossGbpMicros: 52_800 })],
    payToBalance: 99_000n,
    ledgerChainOk: true,
  };
}
const codes = (i: ReconcileInput) => reconcile(i).problems.map((p) => p.code);

describe("reconcile", () => {
  it("a consistent ledger and chain reconcile cleanly", () => {
    const r = reconcile(clean());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.totals).toEqual({ settledCount: 2, settledAtomic: 99_000n, payToBalance: 99_000n, transferCount: 2 });
  });

  it("matches payer and nonce case-insensitively", () => {
    const i = clean();
    i.transfers[0] = transfer(1, { from: A.toUpperCase().replace("0X", "0x"), nonce: n(1).toUpperCase().replace("0X", "0x") });
    expect(codes(i)).toEqual([]);
  });

  it("a settled payment whose tx is null (resolved from nonce state) still reconciles by nonce", () => {
    const i = clean();
    i.payments[0] = payment(1, { tx: null });
    i.journal[0] = journal(1, { tx: null });
    expect(codes(i)).toEqual([]);
  });

  it("flags payments still pending settlement", () => {
    const i = clean();
    i.payments.push(payment(4, { status: "verified", tx: null }));
    expect(reconcile(i).problems).toEqual([{ code: "pending_payments", ids: ["p4"] }]);
  });

  it("flags a broken ledger hash chain", () => {
    expect(codes({ ...clean(), ledgerChainOk: false })).toEqual(["ledger_chain_broken"]);
  });

  it("flags money that arrived with no ledger record (and the balance it leaves unexplained)", () => {
    const i = clean();
    i.transfers.push(transfer(9, { from: B }));
    i.payToBalance += 33_000n;
    expect(codes(i)).toEqual(["unrecorded_onchain_transfer", "balance_mismatch"]);
  });

  it("flags a plain transfer (no EIP-3009 nonce) into payTo", () => {
    const i = clean();
    i.transfers.push(transfer(9, { nonce: null }));
    i.payToBalance += 33_000n;
    expect(reconcile(i).problems[0]).toMatchObject({ code: "unrecorded_onchain_transfer", nonce: null });
  });

  it("I5: flags a cancelled payment that moved money anyway", () => {
    const i = clean();
    i.transfers.push(transfer(3));
    i.payToBalance += 33_000n;
    expect(reconcile(i).problems).toContainEqual({ code: "onchain_but_not_settled", id: "p3", status: "cancelled", tx: tx(3) });
  });

  it("flags a settled payment with no transfer on chain", () => {
    const i = clean();
    i.transfers.pop();
    i.payToBalance = 33_000n;
    expect(codes(i)).toEqual(["settled_without_onchain_transfer", "balance_mismatch"]);
  });

  it("flags amount and tx mismatches", () => {
    const i = clean();
    i.transfers[0] = transfer(1, { value: 32_999n, tx: tx(7) });
    i.payToBalance -= 1n;
    expect(codes(i)).toEqual(["amount_mismatch", "tx_mismatch", "balance_mismatch"]);
  });

  it("flags journal problems: missing, duplicate, orphan, amount, GBP and tx", () => {
    const missing = clean();
    missing.journal.pop();
    expect(codes(missing)).toEqual(["journal_missing"]);

    const dup = clean();
    dup.journal.push(journal(1));
    expect(codes(dup)).toEqual(["journal_duplicate"]);

    const orphan = clean();
    orphan.journal.push(journal(3));
    expect(codes(orphan)).toEqual(["journal_for_unsettled_payment"]);

    const amount = clean();
    amount.journal[0] = journal(1, { usdcAtomic: 33_001n });
    expect(codes(amount)).toEqual(["journal_amount_mismatch"]);

    const gbp = clean();
    gbp.journal[0] = journal(1, { grossGbpMicros: 26_401 });
    expect(reconcile(gbp).problems).toEqual([{ code: "journal_gbp_mismatch", id: "p1", journal: 26_401, expected: 26_400 }]);

    const jtx = clean();
    jtx.journal[0] = journal(1, { tx: null });
    expect(codes(jtx)).toEqual(["journal_tx_mismatch"]);
  });

  it("flags a balance that the transfers do not explain", () => {
    expect(codes({ ...clean(), payToBalance: 99_001n })).toEqual(["balance_mismatch"]);
  });
});
