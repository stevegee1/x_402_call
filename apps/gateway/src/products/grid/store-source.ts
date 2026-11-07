import type { EnvCache, StoredObservation } from "@mx/env";
import { COUNTRIES, type Country, type GridSource, type HalfHour } from "./source";

/** How far back the live view reaches: the signals only look at now and ahead. */
const LOOKBACK_MS = 2 * 24 * 3_600_000;

export interface StoreSourceHealth {
  /** When the cache last refreshed from the store (null before the first). */
  lastRefreshAt: () => number | null;
  /** When ingest-env last fetched from NESO successfully. */
  ingestLastSuccessAt: () => number | null;
}

export const STORE_LIMITS = {
  /** The cache refreshes every 15 s at least; this long without one means the store is unreachable. */
  maxRefreshAgeMs: 2 * 60_000,
  /** ingest-env checks NESO every 30 s and fetches at least every 10 min. */
  maxIngestAgeMs: 20 * 60_000,
} as const;

/**
 * Grid's live view read from the version store's in-memory cache instead of NESO (GRID_SOURCE=store).
 * fetch() fails when the cache or ingest has gone quiet, so GridFeed's freshness rules (I1) turn
 * that into "stale, never charged" exactly as they do for a failing NESO fetch.
 */
export class StoreGridSource implements GridSource {
  constructor(
    private readonly cache: EnvCache,
    private readonly health: StoreSourceHealth,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(): Promise<HalfHour[]> {
    const t = this.now();
    if (!this.cache.ready) throw new Error("env cache not loaded");
    const refreshed = this.health.lastRefreshAt();
    if (refreshed === null || t - refreshed > STORE_LIMITS.maxRefreshAgeMs) throw new Error("env cache not refreshing (store unreachable)");
    const ingest = this.health.ingestLastSuccessAt();
    if (ingest === null || t - ingest > STORE_LIMITS.maxIngestAgeMs) throw new Error("ingest-env has not fetched recently");

    const byStart = new Map<number, HalfHour>();
    for (const country of COUNTRIES) {
      for (const o of this.cache.asOf(country, t - LOOKBACK_MS, Number.MAX_SAFE_INTEGER)) {
        let h = byStart.get(o.validFrom);
        if (!h) {
          h = { start: o.validFrom, values: { england: null, scotland: null, wales: null } };
          byStart.set(o.validFrom, h);
        }
        h.values[country] = usable(o);
      }
    }
    return [...byStart.values()].sort((a, b) => a.start - b.start);
  }
}

/** Only "ok" values feed the signals; missing or rejected ones are gaps, as they are from NESO. */
export const usable = (o: StoredObservation): number | null => (o.quality === "ok" ? o.value : null);

export type { Country };
