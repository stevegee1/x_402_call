/**
 * Tracks value we have served against verified-but-unsettled payments ("credit risk" of async
 * settlement). When a cap would be exceeded the request path settles synchronously instead.
 *
 * Per-instance counters, rehydrated from the DB on start. With N replicas the effective global cap
 * is N x capTotal; size the cap accordingly (documented in MVP.md).
 */
export class ExposureTracker {
  private byPayer = new Map<string, bigint>();
  total = 0n;

  constructor(
    readonly capTotalAtomic: bigint,
    readonly capPerPayerAtomic: bigint,
  ) {}

  wouldExceed(payer: string, amount: bigint): boolean {
    const p = this.byPayer.get(payer.toLowerCase()) ?? 0n;
    return this.total + amount > this.capTotalAtomic || p + amount > this.capPerPayerAtomic;
  }

  add(payer: string, amount: bigint) {
    const k = payer.toLowerCase();
    this.byPayer.set(k, (this.byPayer.get(k) ?? 0n) + amount);
    this.total += amount;
  }

  release(payer: string, amount: bigint) {
    const k = payer.toLowerCase();
    const next = (this.byPayer.get(k) ?? 0n) - amount;
    if (next <= 0n) this.byPayer.delete(k);
    else this.byPayer.set(k, next);
    this.total = this.total - amount < 0n ? 0n : this.total - amount;
  }

  rehydrate(rows: { payer: string; atomic: bigint }[]) {
    this.byPayer.clear();
    this.total = 0n;
    for (const r of rows) this.add(r.payer, r.atomic);
  }
}

export const usdToAtomic = (usd: number) => BigInt(Math.round(usd * 1_000_000));
