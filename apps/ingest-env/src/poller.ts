import type { DatasetSpec, FetchFailure, VersionWrite } from "@mx/env";
import type { Metrics } from "@mx/shared";

export interface PollerSource {
  lastModified(resourceId: string): Promise<number | null>;
  records(resourceId: string, limit: number): Promise<unknown[]>;
}

export interface PollerStore {
  writeVersion(w: VersionWrite): Promise<number>;
  recordFailure(f: FetchFailure): Promise<void>;
}

export interface PollerLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface PollerOptions {
  /** How often to ask the source whether it has published (cheap metadata call). */
  checkMs: number;
  /** Fetch the records at least this often even if the source says nothing changed. */
  maxFetchIntervalMs: number;
  /** Ceiling for the backoff after consecutive failures. */
  maxBackoffMs: number;
  /**
   * After the publish time moves, keep re-reading on every check until the values change, for at
   * most this long. NESO moves last_modified before the new records are readable: on 2026-11-07 a
   * read 17 s after last_modified still returned the old horizon.
   */
  publishSettleMs: number;
}

export const DEFAULT_POLLER_OPTIONS: PollerOptions = { checkMs: 30_000, maxFetchIntervalMs: 10 * 60_000, maxBackoffMs: 5 * 60_000, publishSettleMs: 5 * 60_000 };

export type TickResult = "fetched" | "unchanged" | "failed";

export interface PollerStatus {
  dataset: string;
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  lastPublishedAt: number | null;
  lastChanged: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Polls one dataset. Each tick asks the source when it last published. It reads the records only
 * when that time moved, when the source doesn't say, or when the last read is older than
 * `maxFetchIntervalMs`. The store appends only what changed, so a read that finds nothing new
 * costs one fetch-log row. A publish is only counted as seen once its values have arrived (or
 * `publishSettleMs` has passed), and a failure never counts it, so the next tick retries.
 */
export class Poller {
  private seenModified: number | null = null;
  private lastFetchAt: number | null = null;
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;
  readonly status: PollerStatus;

  constructor(
    private readonly spec: DatasetSpec,
    private readonly source: PollerSource,
    private readonly store: PollerStore,
    private readonly metrics: Metrics,
    private readonly log: PollerLog,
    private readonly opts: PollerOptions = DEFAULT_POLLER_OPTIONS,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {
    this.status = { dataset: spec.id, lastCheckAt: null, lastSuccessAt: null, lastPublishedAt: null, lastChanged: null, consecutiveFailures: 0, lastError: null };
  }

  /** One check, and a fetch if due. Never throws. */
  async tick(): Promise<TickResult> {
    const labels = { dataset: this.spec.id };
    let modified: number | null = null;
    try {
      modified = await this.source.lastModified(this.spec.resourceId);
      this.status.lastCheckAt = this.now();
      const due =
        modified === null ||
        modified !== this.seenModified ||
        this.lastFetchAt === null ||
        this.now() - this.lastFetchAt >= this.opts.maxFetchIntervalMs;
      if (!due) {
        this.metrics.inc("env_checks_total", { ...labels, result: "unchanged" });
        this.succeeded();
        return "unchanged";
      }

      const records = await this.source.records(this.spec.resourceId, this.spec.fetchLimit);
      const cleaned = this.spec.clean(records);
      const ingestedAt = this.now();
      const changed = await this.store.writeVersion({
        dataset: this.spec.id,
        unit: this.spec.unit,
        ingestedAt,
        publishedAt: modified,
        observations: cleaned.observations,
        dropped: cleaned.dropped,
      });

      // Latency is only ours when we saw the publish time move while watching. On the first fetch
      // after boot, the data may have been published long before we started.
      const moved = modified !== null && modified !== this.seenModified;
      const sawPublish = moved && this.seenModified !== null;
      const settling = moved && changed === 0 && ingestedAt - modified! < this.opts.publishSettleMs;
      if (!settling) this.seenModified = modified;
      this.lastFetchAt = ingestedAt;
      this.status.lastSuccessAt = ingestedAt;
      this.status.lastPublishedAt = modified;
      this.status.lastChanged = changed;
      this.metrics.inc("env_checks_total", { ...labels, result: "fetched" });
      this.metrics.inc("env_rows_changed_total", labels, changed);
      this.metrics.inc("env_rows_dropped_total", labels, cleaned.dropped);
      this.metrics.inc("env_rows_duplicate_total", labels, cleaned.duplicates);
      for (const q of ["missing", "rejected"] as const) {
        const n = cleaned.observations.filter((o) => o.quality === q).length;
        this.metrics.set("env_rows_flagged", n, { ...labels, quality: q });
      }
      this.metrics.set("env_last_success_timestamp_seconds", Math.floor(ingestedAt / 1000), labels);
      if (sawPublish && changed > 0) {
        // From the source's publish time to our durable copy: our share of delivery latency.
        this.metrics.set("env_publish_to_ingest_seconds", Math.max(0, (ingestedAt - modified!) / 1000), labels);
      }
      if (cleaned.dropped > 0 || cleaned.duplicates > 0 || cleaned.observations.length === 0) {
        this.log.warn({ dataset: this.spec.id, dropped: cleaned.dropped, duplicates: cleaned.duplicates, seen: cleaned.observations.length }, "source rows needed cleaning");
      }
      this.log.info({ dataset: this.spec.id, changed, seen: cleaned.observations.length, publishedAt: modified, settling }, "fetched");
      this.succeeded();
      return "fetched";
    } catch (e) {
      const error = message(e);
      this.status.consecutiveFailures++;
      this.status.lastError = error;
      this.metrics.inc("env_checks_total", { ...labels, result: "failed" });
      this.metrics.set("env_consecutive_failures", this.status.consecutiveFailures, labels);
      this.log.warn({ dataset: this.spec.id, err: error, failures: this.status.consecutiveFailures }, "fetch failed");
      await this.store
        .recordFailure({ dataset: this.spec.id, fetchedAt: this.now(), publishedAt: modified, error })
        .catch((e2: unknown) => this.log.warn({ dataset: this.spec.id, err: message(e2) }, "could not log the failed fetch"));
      return "failed";
    }
  }

  private succeeded() {
    this.status.consecutiveFailures = 0;
    this.status.lastError = null;
    this.metrics.set("env_consecutive_failures", 0, { dataset: this.spec.id });
  }

  /** Delay before the next tick: the check interval, or full-jitter exponential backoff after failures. */
  nextDelay(): number {
    const f = this.status.consecutiveFailures;
    if (f === 0) return this.opts.checkMs;
    const ceiling = Math.min(this.opts.maxBackoffMs, this.opts.checkMs * 2 ** Math.min(f, 20));
    return Math.max(this.opts.checkMs, Math.floor(ceiling * this.random()));
  }

  /** Runs tick → wait → tick until stop(). The first tick runs immediately. */
  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      this.running = this.tick();
      await this.running;
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), this.nextDelay());
    };
    void loop();
  }

  /** Stops scheduling and waits for a tick in flight, so shutdown never cuts a write short. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
