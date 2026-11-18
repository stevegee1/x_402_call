import type { EnvCache } from "./cache";
import type { FetchRecord } from "./store";

export interface FollowerStore {
  listen(h: { onNotify: (dataset: string) => void; onReconnect: () => void; onError: (e: unknown) => void }): () => Promise<void>;
  lastSuccess(dataset: string): Promise<FetchRecord | null>;
}

export interface FollowerLog {
  warn(obj: object, msg: string): void;
}

/**
 * Keeps one or more EnvCaches in step with the store over ONE notification connection: a
 * notification refreshes only its dataset's cache; a reconnect and the fallback timer (so a missed
 * notification costs at most one interval) refresh all of them. Also tracks, per dataset, when
 * ingest last fetched successfully, so readers can tell "nothing new" from "ingest is down".
 */
export class EnvFollower {
  private stopListening?: () => Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly caches = new Map<string, EnvCache>();
  private readonly ingestOk = new Map<string, number | null>();
  private readonly failuresBy = new Map<string, number>();
  private listeners: Array<(dataset: string) => void> = [];

  constructor(
    private readonly store: FollowerStore,
    caches: EnvCache | readonly EnvCache[],
    private readonly log: FollowerLog,
    private readonly fallbackMs = 15_000,
  ) {
    const list: readonly EnvCache[] = Array.isArray(caches) ? caches : [caches as EnvCache];
    if (list.length === 0) throw new Error("EnvFollower needs at least one cache");
    for (const c of list) {
      if (this.caches.has(c.dataset)) throw new Error(`two caches for dataset ${c.dataset}: share one instead`);
      this.caches.set(c.dataset, c);
    }
  }

  /** The first cache (the single-dataset API). */
  get cache(): EnvCache {
    return this.caches.values().next().value!;
  }

  /** The cache following `dataset`, if any. */
  cacheFor(dataset: string): EnvCache | undefined {
    return this.caches.get(dataset);
  }

  get datasets(): string[] {
    return [...this.caches.keys()];
  }

  /** When ingest last fetched the first cache's dataset successfully (the single-dataset API). */
  get ingestLastSuccessAt(): number | null {
    return this.ingestLastSuccess(this.cache.dataset);
  }

  /** When ingest last fetched `dataset` successfully (epoch ms), as of the last check. */
  ingestLastSuccess(dataset: string): number | null {
    return this.ingestOk.get(dataset) ?? null;
  }

  /** Consecutive failed refreshes (store unreachable), summed over datasets. */
  get failures(): number {
    let n = 0;
    for (const v of this.failuresBy.values()) n += v;
    return n;
  }

  /**
   * Called after every step for a dataset (notification, reconnect or timer), once its cache and
   * ingest status are current, with that dataset's id. Readers that judge freshness should re-check
   * here, not only on new rows: ingest recovering without new values changes freshness too.
   */
  onUpdate(fn: (dataset: string) => void): void {
    this.listeners.push(fn);
  }

  /** Loads every cache before returning, so the first request is served from memory. */
  async start(): Promise<void> {
    await this.tickAll();
    this.stopListening = this.store.listen({
      onNotify: (ds) => {
        if (this.caches.has(ds)) void this.tick(ds);
      },
      onReconnect: () => void this.tickAll(),
      onError: (e) => this.log.warn({ err: (e as Error)?.message ?? String(e), datasets: this.datasets }, "env notification connection error"),
    });
    this.timer = setInterval(() => void this.tickAll(), this.fallbackMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.stopListening?.();
  }

  /** Never throws: a failure leaves the cache as it was and ages it via lastRefreshAt. */
  private async refresh(cache: EnvCache): Promise<void> {
    try {
      await cache.refresh();
      this.failuresBy.set(cache.dataset, 0);
    } catch (e) {
      const n = (this.failuresBy.get(cache.dataset) ?? 0) + 1;
      this.failuresBy.set(cache.dataset, n);
      this.log.warn({ err: (e as Error).message, dataset: cache.dataset, failures: n }, "env cache refresh failed");
    }
  }

  /** Every dataset, in parallel. Never throws. */
  async tickAll(): Promise<void> {
    await Promise.all(this.datasets.map((d) => this.tick(d)));
  }

  /** Refreshes one dataset's cache (default: the first), then its ingest status, then tells listeners. Never throws. */
  async tick(dataset: string = this.cache.dataset): Promise<void> {
    const cache = this.caches.get(dataset);
    if (!cache) return;
    // Status first, then the cache: a fetch committing in between leaves the cache newer than the
    // status (harmless), never a status that names a fetch the cache hasn't loaded yet.
    try {
      this.ingestOk.set(dataset, (await this.store.lastSuccess(dataset))?.fetchedAt ?? null);
    } catch (e) {
      this.log.warn({ err: (e as Error).message, dataset }, "could not read ingest status");
    }
    await this.refresh(cache);
    for (const l of this.listeners) {
      try {
        l(dataset);
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, "env follower listener failed");
      }
    }
  }
}
