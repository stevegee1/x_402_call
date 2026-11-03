import type { Logger } from "../../logger";
import { COUNTRIES, PERIOD_MS, type Country, type GridSource, type HalfHour } from "./source";

/** Freshness rules: when any fails, the scope is stale and paid calls return 503 uncharged (I1). */
export const FRESHNESS = {
  /** A successful fetch within this long (polling every 10 min tolerates a few failures). */
  maxFetchAgeMs: 45 * 60_000,
  /** The forecast must reach at least this far ahead of now. */
  minHorizonMs: 12 * 3_600_000,
  /**
   * The forecast horizon must have moved forward within this long. A healthy source publishes a
   * new half-hour every 30 min; a frozen one (as NESO's regional dataset did) stops advancing while
   * its last forecast still looks plausible.
   */
  maxAdvanceAgeMs: 3 * 3_600_000,
  /** At boot we have no history: trust the horizon only if it looks like a healthy ~48 h one. */
  bootHorizonMs: 40 * 3_600_000,
} as const;

export interface CountryState {
  fresh: boolean;
  /** Why not fresh (first failed rule), for /status and logs. */
  reason: "ok" | "no_data" | "fetch_stale" | "no_current_period" | "short_horizon" | "not_advancing";
  horizonEnd: number | null;
  /** When this country's horizon last moved forward: our proxy for "newest upstream data". */
  advancedAt: number | null;
}

export class GridFeed {
  private periods: HalfHour[] = [];
  private lastSuccess: number | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private horizon = new Map<Country, { end: number; advancedAt: number | null }>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly source: GridSource,
    private readonly log: Pick<Logger, "warn" | "info">,
    private readonly pollMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Schedules polling. Call `poll()` once first so the gateway boots with data. */
  start() {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** One fetch. Never throws: a failure keeps the last good data and ages it out via the rules. */
  async poll(): Promise<void> {
    try {
      const periods = await this.source.fetch();
      const t = this.now();
      for (const c of COUNTRIES) {
        const known = periods.filter((p) => p.values[c] !== null);
        const end = known.length ? known[known.length - 1]!.start + PERIOD_MS : null;
        const prev = this.horizon.get(c);
        if (end === null) continue;
        if (!prev) this.horizon.set(c, { end, advancedAt: end - t >= FRESHNESS.bootHorizonMs ? t : null });
        else if (end > prev.end) this.horizon.set(c, { end, advancedAt: t });
        else if (end < prev.end) this.horizon.set(c, { end, advancedAt: prev.advancedAt }); // shrank: do not credit an advance
      }
      this.periods = periods;
      this.lastSuccess = t;
      this.lastError = null;
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.lastError = (e as Error).message;
      this.log.warn({ err: e, failures: this.failures }, "grid source fetch failed");
    }
  }

  data(): readonly HalfHour[] {
    return this.periods;
  }

  state(country: Country): CountryState {
    const t = this.now();
    const h = this.horizon.get(country) ?? null;
    const base = { horizonEnd: h?.end ?? null, advancedAt: h?.advancedAt ?? null };
    if (!this.lastSuccess || !h) return { fresh: false, reason: "no_data", ...base };
    if (t - this.lastSuccess > FRESHNESS.maxFetchAgeMs) return { fresh: false, reason: "fetch_stale", ...base };
    const curStart = t - (t % PERIOD_MS);
    if (!this.periods.some((p) => p.start === curStart && p.values[country] !== null)) return { fresh: false, reason: "no_current_period", ...base };
    if (h.end - t < FRESHNESS.minHorizonMs) return { fresh: false, reason: "short_horizon", ...base };
    if (h.advancedAt === null || t - h.advancedAt > FRESHNESS.maxAdvanceAgeMs) return { fresh: false, reason: "not_advancing", ...base };
    return { fresh: true, reason: "ok", ...base };
  }

  health() {
    return { last_success: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : null, consecutive_failures: this.failures, last_error: this.lastError, periods: this.periods.length };
  }
}
