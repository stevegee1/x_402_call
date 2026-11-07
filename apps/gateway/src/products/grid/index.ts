import type { Metrics } from "../../metrics";
import type { Precheck, PricedResource, Product, ProductContext, ProductRoutes, ProductStatus, Resolution } from "../../platform/product";
import type { GridFeed } from "./feed";
import type { GridHistory } from "./history";
import { GRID_HISTORY_RESOURCES, GRID_RESOURCES, GRID_STREAM_RESOURCES } from "./resources";
import type { GridUpdates } from "./updates";
import { cleanestWindow, current, iso, series } from "./signals";
import { COUNTRIES, isCountry, PERIOD_MS, SOURCE, type Country, type HalfHour } from "./source";

export interface GridState {
  country: Country;
  periods: readonly HalfHour[];
  /** Pinned at resolve time so the precheck and handler see the same "now". */
  now: number;
}

/** Query parameters, parsed once in the precheck (before any charge) and again, identically, in the handler. */
function forecastHours(c: ProductContext): number | null {
  const v = c.req.query("hours");
  if (v === undefined) return 24;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 48 ? n : null;
}

function windowParams(c: ProductContext): { durationH: number; withinH: number } | null {
  const d = Number(c.req.query("duration_h"));
  const raw = c.req.query("within_h");
  const w = raw === undefined ? 24 : Number(raw);
  const halfSteps = (x: number) => Number.isFinite(x) && Math.abs(x * 2 - Math.round(x * 2)) < 1e-9;
  if (!halfSteps(d) || d < 0.5 || d > 12) return null;
  if (!halfSteps(w) || w < d || w > 48) return null;
  return { durationH: d, withinH: w };
}

/** ISO 8601 with an explicit zone, so a time is never read in the server's local time. */
const ISO_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function instant(v: string | undefined): number | null {
  if (v === undefined || !ISO_ZONED.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const MAX_HISTORY_SPAN_MS = 7 * 24 * 3_600_000;

type HistoryParams = { from: number; to: number; asOf: number | undefined };
/** Parsed before charging; an error string means refuse with 400. `now` bounds as_of. */
function historyParams(c: ProductContext, now: number): HistoryParams | string {
  const from = instant(c.req.query("from"));
  if (from === null) return "from is required: ISO 8601 with a zone, e.g. 2026-11-07T00:00:00Z";
  const rawTo = c.req.query("to");
  const to = rawTo === undefined ? from + 24 * 3_600_000 : instant(rawTo);
  if (to === null) return "to must be ISO 8601 with a zone";
  if (!(to > from)) return "to must be after from";
  if (to - from > MAX_HISTORY_SPAN_MS) return "the range can be at most 7 days";
  const rawAsOf = c.req.query("as_of");
  if (rawAsOf === undefined) return { from, to, asOf: undefined };
  const asOf = instant(rawAsOf);
  if (asOf === null) return "as_of must be ISO 8601 with a zone";
  if (asOf > now) return "as_of cannot be in the future";
  return { from, to, asOf };
}

function revisionPeriod(c: ProductContext): number | string {
  const t = instant(c.req.query("period"));
  if (t === null) return "period is required: ISO 8601 with a zone, e.g. 2026-11-07T13:00:00Z";
  if (t % PERIOD_MS !== 0) return "period must start on :00 or :30";
  return t;
}

type VersionFields = { value: number | null; quality: string; ingestedAt: number; publishedAt: number | null };
/** One stored version as served: known_at is when we first held it (the as-of key). */
const versionBody = (o: VersionFields) => ({
  intensity: o.value,
  quality: o.quality,
  known_at: iso(o.ingestedAt),
  published_at: o.publishedAt === null ? null : iso(o.publishedAt),
});
const periodVersion = (o: VersionFields & { validFrom: number }) => ({ from: iso(o.validFrom), ...versionBody(o) });

/** History older than the memory window lives in Postgres; if that read fails, say so and refund. */
function unavailable(c: ProductContext) {
  c.header("Retry-After", "15");
  return c.json({ error: "history_unavailable", detail: "history is temporarily unavailable; you have not been charged" }, 503);
}

const bad = (c: ProductContext, detail: string) => c.json({ error: "invalid_parameters", detail: `${detail}; you have not been charged` }, 400);

/**
 * Grid carbon intensity for data-centre workload scheduling (England, Scotland, Wales). Data from
 * NESO under the NESO Open Data Licence; every response carries the required attribution.
 */
export class GridProduct implements Product<GridState> {
  readonly id = "grid";
  readonly displayName = "Grid carbon";
  readonly description =
    "GB grid carbon intensity signals for carbon-aware scheduling: now, a half-hourly forecast, and the cleanest window to run a job. Supported by National Energy SO Open Data.";
  readonly resources: readonly PricedResource[];

  /**
   * @param history point-in-time reads from the version store (GRID_SOURCE=store). Without it the
   * history resources are not offered at all.
   * @param updates new-version notifications; with it (and sessions enabled) Grid offers push.
   */
  constructor(
    private readonly feed: GridFeed,
    private readonly now: () => number = Date.now,
    private readonly history?: GridHistory,
    private readonly updates?: GridUpdates,
  ) {
    this.resources = [...GRID_RESOURCES, ...(history ? GRID_HISTORY_RESOURCES : []), ...(updates ? GRID_STREAM_RESOURCES : [])];
  }

  resolve(c: ProductContext): Resolution<GridState> | Response {
    const country = c.req.param("country") ?? "";
    if (!isCountry(country)) return c.json({ error: "unknown_country", countries: COUNTRIES }, 404);
    const s = this.feed.state(country);
    return {
      scope: { scope: country, fresh: s.fresh, mode: "live", sourceTs: s.advancedAt },
      state: { country, periods: this.feed.data(), now: this.now() },
    };
  }

  private envelope(s: GridState, data: Record<string, unknown>) {
    const st = this.feed.state(s.country);
    return {
      country: s.country,
      unit: "gCO2/kWh",
      mode: "live",
      generated_at: iso(s.now),
      forecast_until: st.horizonEnd ? iso(st.horizonEnd) : null,
      ...data,
      source: SOURCE,
    };
  }

  routes(r: ProductRoutes<GridState>): void {
    r.free("/countries", (c) =>
      c.json({
        data: COUNTRIES.map((id) => {
          const s = this.feed.state(id);
          return {
            id,
            fresh: s.fresh,
            forecast_until: s.horizonEnd ? iso(s.horizonEnd) : null,
            endpoints: this.resources.map((e) => ({
              id: e.id,
              path: `/v1/${this.id}${e.path.replace(":country", id)}`,
              price_usdc: e.pricing.priceUsd,
              price_credits_gbp: e.pricing.creditsGbpMicros / 1e6,
              description: e.summary,
            })),
          };
        }),
        source: SOURCE,
      }),
    );

    r.paid(
      "grid.intensity",
      (c, s) => {
        const cur = current(s.periods, s.country, s.now);
        return cur ? c.json(this.envelope(s, cur)) : c.json({ error: "no_current_period" }, 503); // 503 after charge: billing refunds/cancels (I5)
      },
      { precheck: (c, s) => (current(s.periods, s.country, s.now) ? null : c.json({ error: "data_unavailable", detail: "no value for this half-hour; you have not been charged" }, 503)) },
    );

    const forecastPrecheck: Precheck<GridState> = (c) => (forecastHours(c) === null ? bad(c, "hours must be an integer from 1 to 48") : null);
    r.paid(
      "grid.forecast",
      (c, s) => {
        const hours = forecastHours(c)!;
        const pts = series(s.periods, s.country, s.now, hours);
        return c.json(this.envelope(s, { hours, count: pts.length, data: pts.map((p) => ({ from: iso(p.start), intensity: p.intensity })) }));
      },
      { precheck: forecastPrecheck },
    );

    r.paid(
      "grid.window",
      (c, s) => {
        const p = windowParams(c)!;
        const w = cleanestWindow(s.periods, s.country, s.now, p.durationH, p.withinH);
        return w ? c.json(this.envelope(s, { duration_h: p.durationH, within_h: p.withinH, window: w })) : c.json({ error: "no_window" }, 503);
      },
      {
        // Everything is decided before charging: bad parameters, or a horizon too short to fit the job.
        precheck: (c, s) => {
          const p = windowParams(c);
          if (!p) return bad(c, "duration_h must be 0.5-12 and within_h duration_h-48, both in half-hour steps");
          if (!cleanestWindow(s.periods, s.country, s.now, p.durationH, p.withinH)) {
            return c.json({ error: "no_window", detail: "the forecast does not cover a window that long; you have not been charged" }, 422);
          }
          return null;
        },
      },
    );

    if (this.history) this.historyRoutes(r, this.history);
    if (this.updates) this.streamRoutes(r, this.updates);
  }

  /** The country's live view as one event: now, and the forecast ahead. */
  private snapshot(country: Country) {
    const t = this.now();
    const s: GridState = { country, periods: this.feed.data(), now: t };
    const pts = series(s.periods, country, t, 48);
    return this.envelope(s, { current: current(s.periods, country, t), forecast: pts.map((p) => ({ from: iso(p.start), intensity: p.intensity })) });
  }

  private streamRoutes(r: ProductRoutes<GridState>, updates: GridUpdates) {
    r.stream("grid.stream", (_c, s, emit) => {
      const send = () => {
        // A stale feed sends nothing (and charges nothing) until it recovers (I1).
        if (this.feed.state(s.country).fresh) void emit("forecast", this.snapshot(s.country));
      };
      send();
      return updates.subscribe(send);
    });
  }

  private historyRoutes(r: ProductRoutes<GridState>, history: GridHistory) {
    r.paid(
      "grid.history",
      async (c, s) => {
        const p = historyParams(c, s.now) as HistoryParams; // validated in the precheck
        const read = await history.history(s.country, p.from, p.to, p.asOf).catch(() => null);
        if (!read) return unavailable(c); // after charge: billing refunds or cancels (I5)
        const { rows } = read;
        return c.json(
          this.envelope(s, {
            from: iso(p.from),
            to: iso(p.to),
            as_of: p.asOf === undefined ? null : iso(p.asOf),
            count: rows.length,
            data: rows.map(periodVersion),
          }),
        );
      },
      {
        precheck: (c, s) => {
          const p = historyParams(c, s.now);
          return typeof p === "string" ? bad(c, p) : null;
        },
      },
    );

    r.paid(
      "grid.revisions",
      async (c, s) => {
        const period = revisionPeriod(c) as number;
        const read = await history.revisions(s.country, period).catch(() => null);
        if (!read) return unavailable(c);
        const { rows } = read;
        return c.json(this.envelope(s, { period: iso(period), count: rows.length, revisions: rows.map(versionBody) }));
      },
      {
        precheck: (c) => {
          const p = revisionPeriod(c);
          return typeof p === "string" ? bad(c, p) : null;
        },
      },
    );
  }

  status(): ProductStatus {
    return {
      // An upstream outage makes calls 503 (uncharged); it must not take the gateway out of rotation.
      ready: true,
      scopes: COUNTRIES.map((id) => {
        const s = this.feed.state(id);
        return { scope: id, fresh: s.fresh, mode: "live" as const, sourceTs: s.advancedAt, reason: s.reason, forecast_until: s.horizonEnd ? iso(s.horizonEnd) : null };
      }),
      detail: { source: SOURCE.name, ...this.feed.health(), ...(this.history ? { history: this.history.status() } : {}) },
    };
  }

  collectMetrics(m: Metrics): void {
    for (const id of COUNTRIES) {
      const s = this.feed.state(id);
      m.set("grid_fresh", s.fresh ? 1 : 0, { country: id });
      m.set("grid_horizon_hours", s.horizonEnd ? Math.max(0, (s.horizonEnd - this.now()) / 3_600_000) : 0, { country: id });
    }
    m.set("grid_source_consecutive_failures", this.feed.health().consecutive_failures);
    if (this.history) {
      const h = this.history.status();
      m.set("grid_history_cache_versions", h.cached_versions);
      for (const path of ["memory", "store"] as const) m.set("grid_history_reads", this.history.reads[path], { path });
    }
  }
}
