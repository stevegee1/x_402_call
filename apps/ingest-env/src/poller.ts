import type { DatasetSpec, FetchFailure, VersionWrite } from "@mx/env";
import type { Metrics } from "@mx/shared";

export interface PollerSource {
  lastModified(resourceId: string): Promise<number | null>;
  records(resourceId: string, limit: number, sort: string): Promise<unknown[]>;
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

/** Cleaning dropped at least this share of a fetch's rows: the source format has probably changed. */
export const DROP_ALERT_RATIO = 0.05;

export type TickResult = "fetched" | "unchanged" | "unstable" | "failed";

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
      // minFetchIntervalMs is a floor on reads: only a new publish time (a new release) beats it.
      // Without it, a source with no publish time is read on every check, and every source at
      // least every maxFetchIntervalMs.
      const tooSoon = this.lastFetchAt !== null && this.now() - this.lastFetchAt < (this.spec.minFetchIntervalMs ?? 0);
      const due =
        this.lastFetchAt === null ||
        (modified !== null && modified !== this.seenModified) ||
        (!tooSoon && (modified === null || modified !== this.seenModified || this.now() - this.lastFetchAt! >= this.opts.maxFetchIntervalMs));
      if (!due) {
        this.metrics.inc("env_checks_total", { ...labels, result: "unchanged" });
        this.succeeded();
        return "unchanged";
      }

      const records = await this.source.records(this.spec.resourceId, this.spec.fetchLimit, this.spec.sort);
      if (this.spec.wholeResource) {
        // Each run replaces the whole resource. If NESO published during our read, the rows may be
        // part old run, part new: store nothing, and read again next check (the time moved, so it's due).
        const after = await this.source.lastModified(this.spec.resourceId);
        if (after !== modified) {
          this.metrics.inc("env_checks_total", { ...labels, result: "unstable" });
          this.log.info({ dataset: this.spec.id, publishedAt: modified, publishedAfter: after }, "source published during the read: reading again");
          this.succeeded();
          return "unstable";
        }
      }
      // The resource should fit in one read; a full read means the far end of the horizon was cut.
      const truncated = this.spec.wholeResource && records.length >= this.spec.fetchLimit;
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
      this.metrics.set("env_rows_dropped_ratio", records.length === 0 ? 0 : cleaned.dropped / records.length, labels);
      if (truncated) {
        this.metrics.inc("env_fetch_truncated_total", labels);
        this.log.warn({ dataset: this.spec.id, limit: this.spec.fetchLimit }, "fetch hit its row limit: the forecast horizon was cut, raise fetchLimit");
      }
      if (cleaned.dropped > 0 || cleaned.duplicates > 0 || (cleaned.observations.length === 0 && !this.spec.emptyIsNormal)) {
        const alarming = records.length > 0 && cleaned.dropped / records.length >= DROP_ALERT_RATIO;
        this.log.warn(
          { dataset: this.spec.id, dropped: cleaned.dropped, duplicates: cleaned.duplicates, seen: cleaned.observations.length, rows: records.length },
          alarming ? "source rows could not be placed: the source format may have changed" : "source rows needed cleaning",
        );
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
    // A slow-moving dataset may check less often than the default (a quarterly release needn't be asked about every 30 s).
    const checkMs = Math.max(this.opts.checkMs, this.spec.checkIntervalMs ?? 0);
    const f = this.status.consecutiveFailures;
    if (f === 0) return checkMs;
    const ceiling = Math.min(Math.max(this.opts.maxBackoffMs, checkMs), checkMs * 2 ** Math.min(f, 20));
    return Math.max(checkMs, Math.floor(ceiling * this.random()));
  }

  /**
   * Runs tick → wait → tick until stop(). The first tick runs after `initialDelayMs` (default 0),
   * so several pollers can be staggered instead of all checking the source at the same moment.
   */
  start(initialDelayMs = 0): void {
    const loop = async () => {
      if (this.stopped) return;
      this.running = this.tick();
      await this.running;
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), this.nextDelay());
    };
    if (initialDelayMs > 0) this.timer = setTimeout(() => void loop(), initialDelayMs);
    else void loop();
  }

  /** Stops scheduling and waits for a tick in flight, so shutdown never cuts a write short. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
