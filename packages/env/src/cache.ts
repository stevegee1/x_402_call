import type { ChangeRow } from "./store";
import type { StoredObservation } from "./types";

/** What the cache reads from: PgEnvStore in production, a fake in tests. */
export interface CacheSource {
  snapshot(dataset: string, regions: readonly string[], validFromMin: number): Promise<{ rows: ChangeRow[]; maxSeq: number }>;
  changesSince(dataset: string, afterSeq: number, validFromMin: number, limit?: number): Promise<ChangeRow[]>;
}

export interface EnvCacheOptions {
  dataset: string;
  regions: readonly string[];
  /** Keep every version of periods starting no earlier than now − windowMs. Older reads go to the store. */
  windowMs: number;
  /** Page size for catching up. */
  pageSize?: number;
}

type Version = Omit<StoredObservation, "region" | "validFrom">;

/** Periods of one region, sorted by start, each with its versions sorted by ingestedAt. */
class RegionSeries {
  starts: number[] = [];
  versions = new Map<number, Version[]>();

  add(validFrom: number, v: Version) {
    let list = this.versions.get(validFrom);
    if (!list) {
      list = [];
      this.versions.set(validFrom, list);
      this.starts.splice(upperBound(this.starts, validFrom), 0, validFrom);
    }
    // Writers append in commit order, which almost always matches ingestedAt; insert in place if not.
    const at = upperBoundBy(list, v.ingestedAt, (x) => x.ingestedAt);
    list.splice(at, 0, v);
  }

  pruneBefore(t: number) {
    const cut = lowerBound(this.starts, t);
    for (const s of this.starts.slice(0, cut)) this.versions.delete(s);
    this.starts.splice(0, cut);
  }
}

/** First index with a[i] >= x. */
function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with a[i] > x. */
const upperBound = (a: readonly number[], x: number) => upperBoundBy(a, x, (v) => v);

function upperBoundBy<T>(a: readonly T[], x: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(a[mid]!) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The recent window of one dataset in memory: every version of every period, so both "latest" and
 * "as of T" reads are memory lookups (architecture.md §6.4). It loads a consistent snapshot, then
 * follows new versions by seq. The caller decides when to refresh: on a Postgres notification,
 * and on a timer as a fallback.
 *
 * Reads are synchronous and never touch the database. A read that starts before the window is not
 * answerable here (see `covers`), and the caller sends it to the store.
 */
export class EnvCache {
  private readonly series = new Map<string, RegionSeries>();
  private seq = 0;
  private loaded = false;
  private refreshing?: Promise<number>;
  private again = false;
  private listeners: Array<(changed: number) => void> = [];
  /** When the last refresh completed (epoch ms), or null before the first. */
  lastRefreshAt: number | null = null;
  /** Total versions held. */
  size = 0;

  constructor(
    private readonly source: CacheSource,
    readonly opts: EnvCacheOptions,
    private readonly now: () => number = Date.now,
  ) {
    for (const r of opts.regions) this.series.set(r, new RegionSeries());
  }

  get dataset(): string {
    return this.opts.dataset;
  }

  get ready(): boolean {
    return this.loaded;
  }

  /** Earliest period start this cache can answer for. */
  windowStart(): number {
    return this.now() - this.opts.windowMs;
  }

  /** True when every period in [from, …) is held here. */
  covers(from: number): boolean {
    return this.loaded && from >= this.windowStart();
  }

  /** Called with the number of new versions after each refresh that found some. */
  onChange(fn: (changed: number) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /**
   * Loads the snapshot on first call, then whatever was appended since. Concurrent calls share one
   * run, and a call during a run schedules one more, so a notification is never lost. Returns how
   * many new versions this run applied.
   */
  refresh(): Promise<number> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      let total = 0;
      try {
        do {
          this.again = false;
          total += await this.runOnce();
        } while (this.again);
      } finally {
        this.refreshing = undefined;
      }
      this.lastRefreshAt = this.now();
      if (total > 0) for (const l of this.listeners) l(total);
      return total;
    })();
    return this.refreshing;
  }

  private async runOnce(): Promise<number> {
    const min = this.windowStart();
    let applied = 0;
    if (!this.loaded) {
      const snap = await this.source.snapshot(this.opts.dataset, this.opts.regions, min);
      for (const row of snap.rows) applied += this.apply(row);
      this.seq = snap.maxSeq;
      this.loaded = true;
    }
    const page = this.opts.pageSize ?? 5_000;
    for (;;) {
      const rows = await this.source.changesSince(this.opts.dataset, this.seq, min, page);
      for (const row of rows) {
        applied += this.apply(row);
        this.seq = Math.max(this.seq, row.seq);
      }
      if (rows.length < page) break;
    }
    for (const s of this.series.values()) s.pruneBefore(min);
    this.size = [...this.series.values()].reduce((n, s) => n + [...s.versions.values()].reduce((m, v) => m + v.length, 0), 0);
    return applied;
  }

  private apply(row: ChangeRow): number {
    const s = this.series.get(row.region);
    if (!s) return 0; // a region this cache doesn't serve
    s.add(row.validFrom, { value: row.value, quality: row.quality, rawValue: row.rawValue, ingestedAt: row.ingestedAt, publishedAt: row.publishedAt });
    return 1;
  }

  /**
   * For each period in [from, to), the version current at `asOf` (latest if omitted). Periods not
   * yet known at `asOf` are absent, as in the store's point-in-time read.
   */
  asOf(region: string, from: number, to: number, asOf?: number): StoredObservation[] {
    const s = this.series.get(region);
    if (!s) return [];
    const out: StoredObservation[] = [];
    for (let i = lowerBound(s.starts, from); i < s.starts.length && s.starts[i]! < to; i++) {
      const start = s.starts[i]!;
      const list = s.versions.get(start)!;
      const at = asOf === undefined ? list.length : upperBoundBy(list, asOf, (v) => v.ingestedAt);
      if (at === 0) continue;
      out.push({ region, validFrom: start, ...list[at - 1]! });
    }
    return out;
  }

  /** Every version of one period, oldest first. */
  revisions(region: string, validFrom: number): StoredObservation[] {
    const list = this.series.get(region)?.versions.get(validFrom) ?? [];
    return list.map((v) => ({ region, validFrom, ...v }));
  }

  /** Highest seq applied: how far this cache has followed the store. */
  get position(): number {
    return this.seq;
  }
}
