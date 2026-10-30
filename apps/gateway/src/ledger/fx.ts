export interface FxQuote {
  rate: number;
  source: string;
  at: string;
}

export interface FxService {
  usdcGbp(): Promise<FxQuote>;
}

/**
 * USDC->GBP spot from Coinbase's public price endpoint, cached for 60s.
 * Every x402 journal stores the quote it used (HMRC: value cryptoassets at time of supply).
 */
export class CoinbaseFx implements FxService {
  private cached?: FxQuote & { fetchedAt: number };

  constructor(
    private readonly fallbackRate: number,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 60_000,
  ) {}

  async usdcGbp(): Promise<FxQuote> {
    const now = Date.now();
    if (this.cached && now - this.cached.fetchedAt < this.ttlMs) return this.cached;
    try {
      const res = await this.fetchImpl("https://api.coinbase.com/v2/prices/USDC-GBP/spot", { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { data?: { amount?: string } };
      const rate = Number(body.data?.amount);
      if (!(rate > 0.3 && rate < 2)) throw new Error(`implausible rate ${body.data?.amount}`);
      this.cached = { rate, source: "coinbase_spot", at: new Date(now).toISOString(), fetchedAt: now };
      return this.cached;
    } catch {
      if (this.cached) return { ...this.cached, source: "coinbase_spot_stale" };
      return { rate: this.fallbackRate, source: "config_fallback", at: new Date(now).toISOString() };
    }
  }
}

export class FixedFx implements FxService {
  constructor(private readonly rate: number) {}
  async usdcGbp(): Promise<FxQuote> {
    return { rate: this.rate, source: "fixed", at: new Date().toISOString() };
  }
}
