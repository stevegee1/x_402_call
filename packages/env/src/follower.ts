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
 * Keeps an EnvCache in step with the store: refreshes on every notification for its dataset, on
 * reconnect, and on a fallback timer (so a missed notification costs at most one interval). Also
 * tracks when ingest last fetched successfully, so readers can tell "nothing new" from "ingest is
 * down".
 */
export class EnvFollower {
  private stopListening?: () => Promise<void>;
  private timer?: NodeJS.Timeout;
  /** When ingest last fetched successfully (epoch ms), as of the last check. */
  ingestLastSuccessAt: number | null = null;
  /** Consecutive failed refreshes (store unreachable). */
  failures = 0;
  private listeners: Array<() => void> = [];

  constructor(
    private readonly store: FollowerStore,
    readonly cache: EnvCache,
    private readonly log: FollowerLog,
    private readonly fallbackMs = 15_000,
  ) {}

  /**
   * Called after every step (notification, reconnect or timer), once both the cache and the ingest
   * status are current. Readers that judge freshness should re-check here, not only on new rows:
   * ingest recovering without new values changes freshness too.
   */
  onUpdate(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Loads the cache before returning, so the first request is served from memory. */
  async start(): Promise<void> {
    await this.tick();
    this.stopListening = this.store.listen({
      onNotify: (ds) => {
        if (ds === this.cache.dataset) void this.tick();
      },
      onReconnect: () => void this.tick(),
      onError: (e) => this.log.warn({ err: (e as Error)?.message ?? String(e), dataset: this.cache.dataset }, "env notification connection error"),
    });
    this.timer = setInterval(() => void this.tick(), this.fallbackMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.stopListening?.();
  }

  /** Never throws: a failure leaves the cache as it was and ages it via lastRefreshAt. */
  private async refresh(): Promise<void> {
    try {
      await this.cache.refresh();
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.log.warn({ err: (e as Error).message, dataset: this.cache.dataset, failures: this.failures }, "env cache refresh failed");
    }
  }

  /** Refreshes the cache, then the ingest status, then tells listeners. Never throws. */
  async tick(): Promise<void> {
    await this.refresh();
    try {
      this.ingestLastSuccessAt = (await this.store.lastSuccess(this.cache.dataset))?.fetchedAt ?? null;
    } catch (e) {
      this.log.warn({ err: (e as Error).message, dataset: this.cache.dataset }, "could not read ingest status");
    }
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, "env follower listener failed");
      }
    }
  }
}
