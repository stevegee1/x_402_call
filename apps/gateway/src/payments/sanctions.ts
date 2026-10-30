import { readFileSync } from "node:fs";

export interface ScreeningResult {
  blocked: boolean;
  reason?: string;
}

export interface SanctionsScreen {
  screen(address: string): Promise<ScreeningResult>;
}

/**
 * Wallet-address screening before we accept a payment.
 *  1. Local denylist (OFAC/OFSI-designated addresses; refreshed by ops).
 *  2. Optional Chainalysis free sanctions API, cached 24h per address.
 * On API failure we fail OPEN by default (log + metric) and fail CLOSED if configured.
 */
export class SanctionsService implements SanctionsScreen {
  private denylist = new Set<string>();
  private cache = new Map<string, { result: ScreeningResult; at: number }>();

  constructor(
    private readonly opts: { denylistPath?: string; chainalysisApiKey?: string; failClosed: boolean; onError?: (e: unknown) => void },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (opts.denylistPath) this.loadDenylist(opts.denylistPath);
  }

  loadDenylist(path: string) {
    const lines = readFileSync(path, "utf8").split("\n");
    this.denylist = new Set(lines.map((l) => l.trim().toLowerCase()).filter((l) => /^0x[0-9a-f]{40}$/.test(l)));
  }

  addToDenylist(address: string) {
    this.denylist.add(address.toLowerCase());
  }

  async screen(address: string): Promise<ScreeningResult> {
    const a = address.toLowerCase();
    if (this.denylist.has(a)) return { blocked: true, reason: "denylist" };
    if (!this.opts.chainalysisApiKey) return { blocked: false };

    const hit = this.cache.get(a);
    if (hit && Date.now() - hit.at < 86_400_000) return hit.result;
    try {
      const res = await this.fetchImpl(`https://public.chainalysis.com/api/v1/address/${a}`, {
        headers: { "X-API-Key": this.opts.chainalysisApiKey, accept: "application/json" },
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) throw new Error(`chainalysis status ${res.status}`);
      const body = (await res.json()) as { identifications?: { category?: string; name?: string }[] };
      const ids = body.identifications ?? [];
      const result: ScreeningResult = ids.length ? { blocked: true, reason: `chainalysis:${ids.map((i) => i.category ?? i.name).join(",")}` } : { blocked: false };
      this.cache.set(a, { result, at: Date.now() });
      return result;
    } catch (e) {
      this.opts.onError?.(e);
      return this.opts.failClosed ? { blocked: true, reason: "screening_unavailable" } : { blocked: false };
    }
  }
}
