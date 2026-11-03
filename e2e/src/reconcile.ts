import { getAddress, type Address, type Hex } from "viem";
import { BASE_SEPOLIA_USDC, clients, USDC_ABI } from "./chain";

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

  const pending = input.payments.filter((p) => p.status === "verified");
  if (pending.length) problems.push({ code: "pending_payments", ids: pending.map((p) => p.id) });
  if (!input.ledgerChainOk) problems.push({ code: "ledger_chain_broken" });

  const byAuth = new Map(input.payments.map((p) => [key(p.payer, p.nonce), p]));
  const matched = new Set<string>();
  for (const t of input.transfers) {
    const p = t.nonce ? byAuth.get(key(t.from, t.nonce)) : undefined;
    if (!p) {
      problems.push({ code: "unrecorded_onchain_transfer", tx: t.tx, from: t.from, value: t.value.toString(), nonce: t.nonce });
      continue;
    }
    matched.add(p.id);
    if (p.status !== "settled") {
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
  if (input.payToBalance !== transferSum || transferSum !== settledAtomic) {
    problems.push({ code: "balance_mismatch", balance: input.payToBalance.toString(), transfers: transferSum.toString(), settled: settledAtomic.toString() });
  }

  return {
    ok: problems.length === 0,
    problems,
    totals: { settledCount: settled.length, settledAtomic, payToBalance: input.payToBalance, transferCount: input.transfers.length },
  };
}

// ---- data sources ----

/** USDC transfers into payTo since fromBlock, each paired with the EIP-3009 nonce it consumed (if any). */
export async function fetchTransfers(rpcUrl: string, payTo: Address, fromBlock: bigint): Promise<ChainTransfer[]> {
  const c = clients(rpcUrl).public;
  const [transfers, used] = await Promise.all([
    c.getContractEvents({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, eventName: "Transfer", args: { to: payTo }, fromBlock, strict: true }),
    c.getContractEvents({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, eventName: "AuthorizationUsed", fromBlock, strict: true }),
  ]);
  // MockUSDC (like FiatToken) emits AuthorizationUsed immediately before the Transfer it authorises.
  const usedAt = new Map(used.map((u) => [`${u.transactionHash}:${u.logIndex}`, u.args]));
  return transfers.map((t) => {
    const auth = usedAt.get(`${t.transactionHash}:${t.logIndex - 1}`);
    const matches = auth && getAddress(auth.authorizer) === getAddress(t.args.from);
    return { tx: t.transactionHash, from: t.args.from.toLowerCase(), value: t.args.value, nonce: matches ? (auth.nonce as Hex) : null };
  });
}

async function admin<T>(gatewayUrl: string, token: string, path: string, as: "json" | "text" = "json"): Promise<T> {
  const res = await fetch(`${gatewayUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (as === "json" ? res.json() : res.text()) as Promise<T>;
}

export async function fetchPayments(gatewayUrl: string, token: string): Promise<LedgerPayment[]> {
  const body = await admin<{ data: { id: string; status: LedgerPayment["status"]; payer: string; nonce: string; amount_atomic: string; tx: string | null }[] }>(
    gatewayUrl,
    token,
    "/admin/payments?limit=500",
  );
  if (body.data.length >= 500) throw new Error("more than 500 payments: reconciliation needs pagination");
  return body.data.map((p) => ({ id: p.id, status: p.status, payer: p.payer, nonce: p.nonce, amountAtomic: BigInt(p.amount_atomic), tx: p.tx }));
}

/** x402 settlement journals, read back from the operator's HMRC export (so the export is reconciled too). */
export async function fetchJournal(gatewayUrl: string, token: string): Promise<JournalSettlement[]> {
  const csv = await admin<string>(gatewayUrl, token, "/admin/ledger.csv", "text");
  const [header, ...rows] = csv.trim().split("\n");
  const cols = header!.split(",");
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`ledger.csv has no ${name} column`);
    return i;
  };
  const [kind, ref, account, debit, usdc, fx, tx] = ["kind", "ref", "account", "debit_gbp", "usdc_amount", "fx_usdc_gbp", "tx_hash"].map(at) as number[];
  return rows
    .map((r) => r.split(","))
    .filter((f) => f[kind!] === "x402_settlement" && f[account!] === "asset:usdc_wallet")
    .map((f) => ({
      ref: f[ref!]!,
      usdcAtomic: BigInt(Math.round(Number(f[usdc!]) * 1e6)),
      grossGbpMicros: Math.round(Number(f[debit!]) * 1e6),
      fx: Number(f[fx!]),
      tx: f[tx!] || null,
    }));
}

export async function reconcileStack(o: { gatewayUrl: string; adminToken: string; rpcUrl: string; payTo: Address; fromBlock: bigint }) {
  const [payments, journal, verify, transfers, payToBalance] = await Promise.all([
    fetchPayments(o.gatewayUrl, o.adminToken),
    fetchJournal(o.gatewayUrl, o.adminToken),
    admin<{ ok: boolean }>(o.gatewayUrl, o.adminToken, "/admin/ledger/verify"),
    fetchTransfers(o.rpcUrl, o.payTo, o.fromBlock),
    clients(o.rpcUrl).public.readContract({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, functionName: "balanceOf", args: [o.payTo] }),
  ]);
  return reconcile({ payments, transfers, journal, payToBalance, ledgerChainOk: verify.ok });
}
