import type { EnvCache } from "./cache";
import type { AsOfQuery } from "./store";
import type { StoredObservation } from "./types";

export interface HistoryStore {
  asOf(q: AsOfQuery): Promise<StoredObservation[]>;
  revisions(dataset: string, region: string, validFrom: number): Promise<StoredObservation[]>;
  firstPeriod(dataset: string, region: string): Promise<number | null>;
}

/** How long a known history start is trusted before asking the store again. */
const START_TTL_MS = 10 * 60_000;
/** While a series has no history yet (or the store failed), ask again at most this often. */
const START_RETRY_MS = 30_000;
/** A lookup slower than this answers from the cache; the query finishes in the background. */
const START_LOOKUP_BUDGET_MS = 250;
/**
 * A store read (history older than the memory window, or a revision) that takes longer than this
 * fails, so the handler answers 503 (never charged: async payments are armed only after a
 * successful response, I15) instead of holding the buyer and a pool connection.
 */
export const STORE_READ_DEADLINE_MS = 1_200;
/**
 * How the gateway opens its version-store pool (server.ts). Reads only. Pool timeouts free the
 * connection behind a read abandoned at its budget; 8 connections so a few abandoned reads can't
 * starve paid ones. Invariants pinned by a test: every paid read's budget is far below them.
 */
export const GATEWAY_ENV_POOL = { max: 8, timeouts: { statementMs: 5_000, queryMs: 6_000, connectMs: 5_000 } } as const;

/** Thrown when a store read runs out of its budget. */
export class StoreReadTimeout extends Error {}

/** Rejects if `p` hasn't settled within `ms`. The timer is always cleared. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (ms <= 0) throw new StoreReadTimeout(`${what}: no time left in its budget`);
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new StoreReadTimeout(`${what} exceeded ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A lookup still running after this is abandoned, so the in-flight entry always settles: callers
 * never pile onto a promise that never ends, and the next request tries again.
 */
const START_LOOKUP_DEADLINE_MS = 3_000;

export type ReadPath = "memory" | "store";

/**
 * Point-in-time reads for one dataset. The recent window is answered from the in-memory cache;
 * anything older goes to Postgres. Both give the same answer for the same question (tested), so
 * where a read is served from never changes what the buyer gets. `R` is the dataset's series names
 * (a product may narrow it, e.g. Grid's countries).
 */
export class EnvHistory<R extends string = string> {
  readonly reads: Record<ReadPath, number> = { memory: 0, store: 0 };
  /** Store reads cut off by their budget: watch this to tune STORE_READ_DEADLINE_MS. */
  storeTimeouts = 0;
  private readonly starts = new Map<string, { value: number | null; known: boolean; checkedAt: number }>();
  /** One store query per series at a time, however many requests ask. */
  private readonly inFlight = new Map<string, Promise<number | null | undefined>>();

  constructor(
    private readonly cache: EnvCache,
    private readonly store: HistoryStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The first period we hold for a series: no history read can return anything earlier.
   * null: the store holds none. undefined: not known right now (no successful lookup yet).
   * Cached, one query per series at a time, and never slower than START_LOOKUP_BUDGET_MS: a slow
   * or failing store answers from the cache, so it can't hang or fail a request.
   */
  async historyFrom(series: R): Promise<number | null | undefined> {
    if (this.fresh(series)) return this.known(series);
    const query = this.refresh(series);
    let timer: NodeJS.Timeout | undefined;
    // The fallback only reads the cache: it never starts another lookup or timer.
    const fallback = new Promise<number | null | undefined>((r) => (timer = setTimeout(() => r(this.known(series)), START_LOOKUP_BUDGET_MS)));
    try {
      return await Promise.race([query, fallback]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The last known start, without waiting on the store: for paths that must not (a refusal, where a
   * slow round trip could outlast the async settle delay). Starts a background refresh if stale.
   */
  cachedHistoryFrom(series: R): number | null | undefined {
    if (!this.fresh(series)) void this.refresh(series);
    return this.known(series);
  }

  /** Fills the cache at boot, so the first refusal already knows where history starts. */
  warm(seriesList: readonly R[]): Promise<unknown> {
    return Promise.all(seriesList.map((c) => this.refresh(c)));
  }

  private known(series: R): number | null | undefined {
    const hit = this.starts.get(series);
    return hit?.known ? hit.value : undefined;
  }

  private fresh(series: R): boolean {
    const hit = this.starts.get(series);
    return hit !== undefined && this.now() - hit.checkedAt < (hit.known && hit.value !== null ? START_TTL_MS : START_RETRY_MS);
  }

  /** The single in-flight lookup for a series, started if there is none. Never rejects. */
  private refresh(series: R): Promise<number | null | undefined> {
    let query = this.inFlight.get(series);
    if (!query) {
      query = this.lookup(series);
      this.inFlight.set(series, query);
      void query.finally(() => this.inFlight.delete(series));
    }
    return query;
  }

  private async lookup(series: R): Promise<number | null | undefined> {
    const prev = this.starts.get(series);
    let deadline: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        this.store.firstPeriod(this.dataset, series),
        new Promise<never>((_, reject) => (deadline = setTimeout(() => reject(new Error("firstPeriod deadline")), START_LOOKUP_DEADLINE_MS))),
      ]);
      this.starts.set(series, { value, known: true, checkedAt: this.now() });
      return value;
    } catch {
      // Keep what we knew; if we never knew, stay "unknown" and retry after START_RETRY_MS.
      this.starts.set(series, { value: prev?.value ?? null, known: prev?.known ?? false, checkedAt: this.now() });
      return prev?.known ? prev.value : undefined;
    } finally {
      clearTimeout(deadline);
    }
  }

  get dataset(): string {
    return this.cache.dataset;
  }

  status() {
    const w = this.cache.ready ? new Date(this.cache.windowStart()).toISOString() : null;
    return { window_start: w, cached_versions: this.cache.size, position: this.cache.position, reads: this.reads };
  }

  private async timed<T>(read: () => Promise<T>, ms: number, what: string): Promise<T> {
    try {
      // No time left: refuse without issuing the query, so no connection is spent on an abandoned read.
      if (ms <= 0) throw new StoreReadTimeout(`${what}: no time left in its budget`);
      return await within(read(), ms, what);
    } catch (e) {
      if (e instanceof StoreReadTimeout) this.storeTimeouts++;
      throw e;
    }
  }

  async history(series: R, from: number, to: number, asOf?: number, budgetMs = STORE_READ_DEADLINE_MS): Promise<{ rows: StoredObservation[]; path: ReadPath }> {
    if (this.cache.covers(from)) {
      this.reads.memory++;
      return { rows: this.cache.asOf(series, from, to, asOf), path: "memory" };
    }
    this.reads.store++;
    return { rows: await this.timed(() => this.store.asOf({ dataset: this.dataset, region: series, from, to, asOf }), budgetMs, "history read"), path: "store" };
  }

  async revisions(series: R, period: number, budgetMs = STORE_READ_DEADLINE_MS): Promise<{ rows: StoredObservation[]; path: ReadPath }> {
    if (this.cache.covers(period)) {
      this.reads.memory++;
      return { rows: this.cache.revisions(series, period), path: "memory" };
    }
    this.reads.store++;
    return { rows: await this.timed(() => this.store.revisions(this.dataset, series, period), budgetMs, "revisions read"), path: "store" };
  }
}
