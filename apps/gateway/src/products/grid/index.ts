import type { Metrics } from "../../metrics";
import type { Precheck, Product, ProductContext, ProductRoutes, ProductStatus, Resolution } from "../../platform/product";
import type { GridFeed } from "./feed";
import { GRID_RESOURCES } from "./resources";
import { cleanestWindow, current, iso, series } from "./signals";
import { COUNTRIES, isCountry, SOURCE, type Country, type HalfHour } from "./source";

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

const bad = (c: ProductContext, detail: string) => c.json({ error: "invalid_parameters", detail: `${detail}; you have not been charged` }, 400);

/**
 * Grid carbon intensity for data-centre workload scheduling (England, Scotland, Wales). Data from
 * NESO under the NESO Open Data Licence; every response carries the required attribution.
 */
export class GridProduct implements Product<GridState> {
  readonly id = "grid";
  readonly displayName = "Grid carbon";
  readonly description =
    "GB grid carbon intensity signals for carbon-aware scheduling: now, a half-hourly forecast, and the cleanest window to run a job. Supported by National Energy SO Open Data. Not provided or endorsed by NESO.";
  readonly resources = GRID_RESOURCES;

  constructor(
    private readonly feed: GridFeed,
    private readonly now: () => number = Date.now,
  ) {}

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
  }

  status(): ProductStatus {
    return {
      // An upstream outage makes calls 503 (uncharged); it must not take the gateway out of rotation.
      ready: true,
      scopes: COUNTRIES.map((id) => {
        const s = this.feed.state(id);
        return { scope: id, fresh: s.fresh, mode: "live" as const, sourceTs: s.advancedAt, reason: s.reason, forecast_until: s.horizonEnd ? iso(s.horizonEnd) : null };
      }),
      detail: { source: SOURCE.name, ...this.feed.health() },
    };
  }

  collectMetrics(m: Metrics): void {
    for (const id of COUNTRIES) {
      const s = this.feed.state(id);
      m.set("grid_fresh", s.fresh ? 1 : 0, { country: id });
      m.set("grid_horizon_hours", s.horizonEnd ? Math.max(0, (s.horizonEnd - this.now()) / 3_600_000) : 0, { country: id });
    }
    m.set("grid_source_consecutive_failures", this.feed.health().consecutive_failures);
  }
}
