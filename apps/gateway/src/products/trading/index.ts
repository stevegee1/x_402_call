import type { EnvCache, EnvHistory, StoredObservation } from "@mx/env";
import type { Metrics } from "../../metrics";
import type { PricedResource, Product, ProductContext, ProductRoutes, ProductStatus, Resolution } from "../../platform/product";
import { TRADING_DATASETS, tradingDataset, type TradingDataset } from "./datasets";
import { TRADING_RESOURCES, TRADING_STREAM_RESOURCES } from "./resources";
import type { TradingUpdates } from "./updates";

/** What the trading feed reads for one dataset: its memory window, its point-in-time reader, and ingest health. */
export interface TradingSource {
  cache: EnvCache;
  history: EnvHistory;
  /** When ingest-env last fetched this dataset successfully (epoch ms), or null if never. */
  ingestLastSuccessAt(): number | null;
}

/**
 * Freshness rules, the same as Grid's on the version store (I1): the cache must be loaded and
 * refreshing, and ingest must have fetched recently. ingest-env fetches every dataset at least every
 * 10 minutes, so 20 minutes without a success means it is down. A stale dataset is refused with 503
 * and never charged; its values are still correct, but we can't say they are current.
 */
export const TRADING_LIMITS = { maxRefreshAgeMs: 2 * 60_000, maxIngestAgeMs: 20 * 60_000 } as const;

export function freshness(src: TradingSource, now: number): { fresh: boolean; reason: string | null } {
  if (!src.cache.ready) return { fresh: false, reason: "cache not loaded" };
  const refreshed = src.cache.lastRefreshAt;
  if (refreshed === null || now - refreshed > TRADING_LIMITS.maxRefreshAgeMs) return { fresh: false, reason: "store unreachable" };
  const ingest = src.ingestLastSuccessAt();
  if (ingest === null || now - ingest > TRADING_LIMITS.maxIngestAgeMs) return { fresh: false, reason: "ingest has not fetched recently" };
  return { fresh: true, reason: null };
}

export interface TradingState {
  ds: TradingDataset;
  /** Set on per-series resources, validated at resolve. */
  series: string | null;
  /** Pinned at resolve time so the precheck and handler see the same "now". */
  now: number;
}

const iso = (t: number) => new Date(t).toISOString();

/** ISO 8601 with an explicit zone, so a time is never read in the server's local time. */
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function instant(v: string | undefined): number | null {
  if (v === undefined || !ISO_ZONED.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export const MAX_HISTORY_SPAN_MS = 7 * 24 * 3_600_000;

type HistoryParams = { from: number; to: number; asOf: number | undefined };
/** Parsed before charging; a string means refuse with 400. `now` bounds as_of. */
export function historyParams(q: (k: string) => string | undefined, now: number): HistoryParams | string {
  const from = instant(q("from"));
  if (from === null) return "from is required: ISO 8601 with a zone, e.g. 2026-11-17T00:00:00Z";
  const rawTo = q("to");
  const to = rawTo === undefined ? from + 24 * 3_600_000 : instant(rawTo);
  if (to === null) return "to must be ISO 8601 with a zone";
  if (!(to > from)) return "to must be after from";
  if (to - from > MAX_HISTORY_SPAN_MS) return "the range can be at most 7 days";
  const rawAsOf = q("as_of");
  if (rawAsOf === undefined) return { from, to, asOf: undefined };
  const asOf = instant(rawAsOf);
  if (asOf === null) return "as_of must be ISO 8601 with a zone";
  if (asOf > now) return "as_of cannot be in the future";
  return { from, to, asOf };
}

export function revisionPeriod(q: (k: string) => string | undefined, periodMs: number): number | string {
  const t = instant(q("period"));
  if (t === null) return "period is required: ISO 8601 with a zone, e.g. 2026-11-17T13:00:00Z";
  if (t % periodMs !== 0) return `period must start on a ${periodMs / 60_000}-minute boundary`;
  return t;
}

type VersionFields = Pick<StoredObservation, "value" | "quality" | "ingestedAt" | "publishedAt">;
/** One stored version as served: known_at is when we first held it (the as-of key). */
const versionBody = (o: VersionFields) => ({
  value: o.value,
  quality: o.quality,
  known_at: iso(o.ingestedAt),
  published_at: o.publishedAt === null ? null : iso(o.publishedAt),
});
const periodVersion = (o: StoredObservation) => ({ from: iso(o.validFrom), ...versionBody(o) });

const bad = (c: ProductContext, detail: string) => c.json({ error: "invalid_parameters", detail: `${detail}; you have not been charged` }, 400);

function unavailable(c: ProductContext) {
  c.header("Retry-After", "15");
  return c.json({ error: "history_unavailable", detail: "history is temporarily unavailable; you have not been charged" }, 503);
}

/**
 * The trading feed: every half-hourly NESO and Elexon series we record, with point-in-time history
 * and revisions, for systematic trading. Reads only the version store (ingest-env writes it).
 */
export class TradingProduct implements Product<TradingState> {
  readonly id = "trading";
  readonly displayName = "Trading feed";
  readonly description: string;
  readonly resources: readonly PricedResource[];

  /**
   * @param sources one per dataset in TRADING_DATASETS, keyed by dataset key.
   * @param updates new-version notifications; with it (and sessions enabled) the feed offers push.
   */
  constructor(
    private readonly sources: ReadonlyMap<string, TradingSource>,
    private readonly now: () => number = Date.now,
    private readonly updates?: TradingUpdates,
  ) {
    const missing = TRADING_DATASETS.filter((d) => !sources.has(d.key)).map((d) => d.key);
    if (missing.length) throw new Error(`trading: no source for ${missing.join(", ")}`);
    this.resources = [...TRADING_RESOURCES, ...(updates ? TRADING_STREAM_RESOURCES : [])];
    this.description = [
      "GB power-market data for systematic trading: carbon intensity, embedded and 14-day wind, solar, 2-14 day demand, generation mix, imbalance and market index prices, half-hourly.",
      "Every published version is kept: point-in-time reads (as_of) for backtests without look-ahead, and each period's revisions.",
      updates ? "A live push stream per dataset." : "",
      "Supported by National Energy SO Open Data; contains BMRS data © Elexon Limited. Not provided or endorsed by NESO or Elexon.",
    ]
      .filter(Boolean)
      .join(" ");
    for (const d of TRADING_DATASETS) void this.src(d).history.warm(d.spec.regions);
  }

  private src(d: TradingDataset): TradingSource {
    return this.sources.get(d.key)!;
  }

  resolve(c: ProductContext): Resolution<TradingState> | Response {
    const ds = tradingDataset(c.req.param("dataset") ?? "");
    if (!ds) return c.json({ error: "unknown_dataset", datasets: TRADING_DATASETS.map((d) => d.key) }, 404);
    const rawSeries = c.req.param("series");
    if (rawSeries !== undefined && !ds.spec.regions.includes(rawSeries)) return c.json({ error: "unknown_series", dataset: ds.key, series: ds.spec.regions }, 404);
    const now = this.now();
    const src = this.src(ds);
    return {
      scope: { scope: ds.key, fresh: freshness(src, now).fresh, mode: "live", sourceTs: src.ingestLastSuccessAt() },
      state: { ds, series: rawSeries ?? null, now },
    };
  }

  private envelope(s: TradingState, data: Record<string, unknown>) {
    return {
      dataset: s.ds.key,
      title: s.ds.title,
      kind: s.ds.kind,
      unit: s.ds.spec.unit,
      period_minutes: s.ds.spec.periodMs / 60_000,
      ...(s.series ? { series: s.series } : {}),
      mode: "live",
      generated_at: iso(s.now),
      ...data,
      source: s.ds.source(s.now),
    };
  }

  /** The newest period at or before `now` for one series, latest version, from memory. */
  private latestOf(d: TradingDataset, series: string, now: number): StoredObservation | null {
    const rows = this.src(d).cache.asOf(series, now - d.memoryMs, now + 1);
    return rows.at(-1) ?? null;
  }

  private latest(d: TradingDataset, now: number) {
    return d.spec.regions.map((series) => {
      const o = this.latestOf(d, series, now);
      return o ? { series, ...periodVersion(o) } : { series, from: null, value: null, quality: null, known_at: null, published_at: null };
    });
  }

  /** The live view: each series' newest period at or before now, then every period ahead (latest versions). */
  private liveView(d: TradingDataset, now: number) {
    const cache = this.src(d).cache;
    return d.spec.regions.map((series) => {
      const head = this.latestOf(d, series, now);
      const from = head ? head.validFrom : now + 1;
      return { series, data: cache.asOf(series, from, Number.MAX_SAFE_INTEGER).map(periodVersion) };
    });
  }

  routes(r: ProductRoutes<TradingState>): void {
    r.free(
      "/datasets",
      async (c) => {
        const now = this.now();
        const data = await Promise.all(
          TRADING_DATASETS.map(async (d) => {
            const src = this.src(d);
            const f = freshness(src, now);
            const starts = await Promise.all(d.spec.regions.map((s) => src.history.historyFrom(s)));
            return {
              key: d.key,
              title: d.title,
              kind: d.kind,
              description: d.description,
              unit: d.spec.unit,
              period_minutes: d.spec.periodMs / 60_000,
              fresh: f.fresh,
              // null when there is none or it isn't known right now (the store is slow or down).
              series: d.spec.regions.map((s, i) => ({ id: s, history_from: typeof starts[i] === "number" ? iso(starts[i]) : null })),
              endpoints: this.resources.map((e) => ({
                id: e.id,
                path: `/v1/${this.id}${e.path.replace(":dataset", d.key)}`,
                price_usdc: e.pricing.priceUsd,
                price_credits_gbp: e.pricing.creditsGbpMicros / 1e6,
                description: e.summary,
              })),
              source: d.source(now),
            };
          }),
        );
        return c.json({ data });
      },
      { summary: "Datasets and series on sale, with freshness, where each series' history begins, prices and sources" },
    );

    r.paid("trading.latest", (c, s) => c.json(this.envelope(s, { data: this.latest(s.ds, s.now) })), {
      // Nothing to sell yet (a dataset never recorded): refuse before charging.
      precheck: (c, s) =>
        s.ds.spec.regions.some((series) => this.latestOf(s.ds, series, s.now)) ? null : c.json({ error: "data_unavailable", detail: "no recorded value at or before now; you have not been charged" }, 503),
    });

    r.paid(
      "trading.history",
      async (c, s) => {
        const p = historyParams((k) => c.req.query(k), s.now) as HistoryParams; // validated in the precheck
        const history = this.src(s.ds).history;
        const read = await history.history(s.series!, p.from, p.to, p.asOf).catch(() => null);
        if (!read) return unavailable(c); // >= 400: billing refunds credits and cancels x402 (I5, I15)
        if (read.rows.length === 0) return this.noHistory(c, s, p.asOf === undefined ? "no period in this range has a recorded version" : "no period in this range had a recorded version at as_of (a version counts from when we first recorded it)");
        return c.json(this.envelope(s, { from: iso(p.from), to: iso(p.to), as_of: p.asOf === undefined ? null : iso(p.asOf), count: read.rows.length, data: read.rows.map(periodVersion) }));
      },
      {
        precheck: (c, s) => {
          const p = historyParams((k) => c.req.query(k), s.now);
          return typeof p === "string" ? bad(c, p) : null;
        },
      },
    );

    r.paid(
      "trading.revisions",
      async (c, s) => {
        const period = revisionPeriod((k) => c.req.query(k), s.ds.spec.periodMs) as number;
        const read = await this.src(s.ds).history.revisions(s.series!, period).catch(() => null);
        if (!read) return unavailable(c);
        if (read.rows.length === 0) return this.noHistory(c, s, "this period has no recorded version");
        return c.json(this.envelope(s, { period: iso(period), count: read.rows.length, revisions: read.rows.map(versionBody) }));
      },
      {
        precheck: (c, s) => {
          const p = revisionPeriod((k) => c.req.query(k), s.ds.spec.periodMs);
          return typeof p === "string" ? bad(c, p) : null;
        },
      },
    );

    if (this.updates) {
      const updates = this.updates;
      r.stream("trading.stream", (_c, s, emit) => {
        const send = () => {
          const now = this.now();
          // A stale dataset sends nothing (and charges nothing) until it recovers (I1).
          if (freshness(this.src(s.ds), now).fresh) void emit("live", this.envelope({ ...s, now }, { data: this.liveView(s.ds, now) }));
        };
        send();
        return updates.subscribe(s.ds.key, send);
      });
    }
  }

  /**
   * A read that found nothing is refused, so it is never charged (I5): a buyer pays only for data.
   * The body says where the series' history begins, from cache only (a store round trip here could
   * outlast the async settle delay).
   */
  private noHistory(c: ProductContext, s: TradingState, what: string) {
    const from = this.src(s.ds).history.cachedHistoryFrom(s.series!);
    const where =
      from === undefined
        ? "where this series' history starts is not known right now (see /v1/trading/datasets)"
        : from === null
          ? "no history is recorded for this series yet"
          : `history for this series starts at ${iso(from)}`;
    return c.json({ error: "no_history", detail: `${what}; ${where}; you have not been charged`, history_from: from ? iso(from) : null }, 404);
  }

  status(): ProductStatus {
    const now = this.now();
    return {
      // A dataset's outage makes its calls 503 (uncharged); it never takes the gateway out of rotation.
      ready: true,
      scopes: TRADING_DATASETS.map((d) => {
        const src = this.src(d);
        const f = freshness(src, now);
        return { scope: d.key, fresh: f.fresh, mode: "live" as const, sourceTs: src.ingestLastSuccessAt(), reason: f.reason, cached_versions: src.cache.size };
      }),
    };
  }

  collectMetrics(m: Metrics): void {
    const now = this.now();
    for (const d of TRADING_DATASETS) {
      const src = this.src(d);
      m.set("trading_fresh", freshness(src, now).fresh ? 1 : 0, { dataset: d.key });
      m.set("trading_cache_versions", src.cache.size, { dataset: d.key });
      for (const path of ["memory", "store"] as const) m.set("trading_history_reads", src.history.reads[path], { dataset: d.key, path });
      m.set("trading_history_store_timeouts", src.history.storeTimeouts, { dataset: d.key });
    }
  }
}
