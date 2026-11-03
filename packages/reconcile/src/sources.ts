import type { JournalSettlement, LedgerPayment } from "./core";

export class GatewayAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(path: string): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
    return res;
  }

  /** Every x402 payment, all statuses, following the keyset cursor. */
  async payments(): Promise<LedgerPayment[]> {
    const out: LedgerPayment[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `/admin/payments?limit=500${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await (await this.get(q)).json()) as {
        next_cursor: string | null;
        data: { id: string; status: LedgerPayment["status"]; payer: string; nonce: string; amount_atomic: string; tx: string | null; created_at: string }[];
      };
      for (const p of body.data) {
        out.push({ id: p.id, status: p.status, payer: p.payer, nonce: p.nonce, amountAtomic: BigInt(p.amount_atomic), tx: p.tx, createdAt: Date.parse(p.created_at) });
      }
      cursor = body.next_cursor;
    } while (cursor);
    return out;
  }

  /** x402 settlement journals, read back from the operator's HMRC export (so the export is reconciled too). */
  async journal(): Promise<JournalSettlement[]> {
    return parseLedgerCsv(await (await this.get("/admin/ledger.csv")).text());
  }

  async ledgerChainOk(): Promise<boolean> {
    return ((await (await this.get("/admin/ledger/verify")).json()) as { ok: boolean }).ok;
  }
}

export function parseLedgerCsv(csv: string): JournalSettlement[] {
  const [header, ...rows] = csv.trim().split("\n");
  const cols = (header ?? "").split(",");
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
