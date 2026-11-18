import { CLUSTER_RIVER_SERIES, floodSeries, SITE_FLOOD_AREAS, WATER_FLOWS, type Site, type StoredObservation } from "@mx/env";
import type { InputKey, SiteSources } from "./inputs";

const MIN = 60_000;
const H = 60 * MIN;
const HALF_HOUR = 30 * MIN;
const FLOOD_PERIOD = 15 * MIN;
const iso = (t: number) => new Date(t).toISOString();

export const FLOOD_SEVERITY: Readonly<Record<number, string>> = { 1: "severe flood warning", 2: "flood warning", 3: "flood alert", 4: "no longer in force" };
export const WATER_CLASS_LABEL: Readonly<Record<number, string>> = { 1: "available", 2: "restricted", 3: "not available", 4: "heavily modified water body (judged locally)" };

type Row = StoredObservation;
const ok = (r: Row) => r.quality === "ok" && r.value !== null;
const knownAt = (rows: readonly Row[]) => (rows.length ? iso(Math.max(...rows.map((r) => r.ingestedAt))) : null);

/** Reads one series' versions in [from, to) as known at `asOf` (memory or store, same answer). Throws on a store failure. */
function reader(sources: SiteSources, asOf: number | undefined) {
  return (key: InputKey, series: string, from: number, to: number) => sources.get(key)!.history.history(series, from, to, asOf).then((r) => r.rows);
}

/** The newest row starting at or before `t` (within `lookbackMs`), or null. */
async function latest(read: ReturnType<typeof reader>, key: InputKey, series: string, t: number, lookbackMs: number): Promise<Row | null> {
  const rows = await read(key, series, t - lookbackMs, t + 1);
  return rows.at(-1) ?? null;
}

export interface ReportOptions {
  /** The moment the report describes (now, or as_of). */
  at: number;
  /** Knowledge time for point-in-time reports; undefined = latest. */
  asOf: number | undefined;
}

/** Carbon intensity for the site's grid region: the current half-hour and the next 24 h. */
export async function carbonSection(sources: SiteSources, site: Site, o: ReportOptions) {
  const read = reader(sources, o.asOf);
  const rows = await read("carbon", site.gridRegion, o.at - HALF_HOUR, o.at + 24 * H);
  const cur = rows.find((r) => r.validFrom <= o.at && o.at < r.validFrom + HALF_HOUR) ?? null;
  const ahead = rows.filter((r) => r.validFrom >= (cur ? cur.validFrom : o.at) && ok(r));
  if (!cur && ahead.length === 0) return null;
  const vals = ahead.map((r) => r.value!);
  const cleanest = ahead.reduce<Row | null>((a, r) => (a === null || r.value! < a.value! ? r : a), null);
  return {
    region: site.gridRegion,
    unit: "gCO2/kWh",
    now: cur ? { from: iso(cur.validFrom), value: cur.value, quality: cur.quality } : null,
    next_24h: vals.length
      ? { periods: vals.length, min: Math.min(...vals), max: Math.max(...vals), mean: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10, cleanest_period: iso(cleanest!.validFrom) }
      : null,
    known_at: knownAt(rows),
  };
}

/** The latest imbalance prices (system sell, system buy) and market index price. */
export async function pricesSection(sources: SiteSources, o: ReportOptions) {
  const read = reader(sources, o.asOf);
  const [ssp, sbp, apx] = await Promise.all([
    latest(read, "system_prices", "ssp", o.at, 6 * H),
    latest(read, "system_prices", "sbp", o.at, 6 * H),
    latest(read, "market_index", "apx", o.at, 6 * H),
  ]);
  if (!ssp && !sbp && !apx) return null;
  const one = (r: Row | null) => (r ? { from: iso(r.validFrom), value: r.value, quality: r.quality } : null);
  return { unit: "GBP/MWh", system_sell: one(ssp), system_buy: one(sbp), market_index: one(apx), known_at: knownAt([ssp, sbp, apx].filter((r): r is Row => r !== null)) };
}

/**
 * Flood warnings in force on the site's EA flood areas, as of the ingest fetch nearest before the
 * report time. An area with no row in that fetch's period had nothing in force (absence is stored
 * as nothing).
 */
export async function floodSection(sources: SiteSources, site: Site, o: ReportOptions) {
  const src = sources.get("flood")!;
  const fetchedAt = o.asOf === undefined ? src.ingestLastSuccessAt() : await src.ingestSuccessAsOf(o.at);
  if (fetchedAt === null) return null;
  const p = Math.floor(fetchedAt / FLOOD_PERIOD) * FLOOD_PERIOD;
  const read = reader(sources, o.asOf);
  const areas = SITE_FLOOD_AREAS[site.id] ?? [];
  const rows = await Promise.all(areas.map((a) => read("flood", floodSeries(a), p, p + FLOOD_PERIOD).then((r) => ({ area: a, row: r.at(-1) ?? null }))));
  const inForce = rows.filter((x) => x.row && ok(x.row) && x.row.value! <= 3).map((x) => ({ area: x.area, severity: x.row!.value!, level: FLOOD_SEVERITY[x.row!.value!] }));
  inForce.sort((a, b) => a.severity - b.severity || (a.area < b.area ? -1 : 1));
  return {
    observed_at: iso(fetchedAt),
    areas_watched: areas.length,
    in_force: inForce,
    most_severe: inForce[0] ? inForce[0].level : null,
    known_at: knownAt(rows.flatMap((x) => (x.row ? [x.row] : []))),
  };
}

/** Latest level at each gauge near the site, with its change over 24 h. */
export async function riversSection(sources: SiteSources, site: Site, o: ReportOptions) {
  const read = reader(sources, o.asOf);
  const gauges = CLUSTER_RIVER_SERIES[site.cluster];
  const out = await Promise.all(
    gauges.map(async (g) => {
      const rows = (await read("rivers", g, o.at - 25 * H, o.at + 1)).filter(ok);
      const last = rows.at(-1);
      if (!last) return { gauge: g, level_m: null, at: null, change_24h_m: null };
      const dayAgo = rows.find((r) => r.validFrom === last.validFrom - 24 * H);
      return { gauge: g, level_m: last.value, at: iso(last.validFrom), change_24h_m: dayAgo ? Math.round((last.value! - dayAgo.value!) * 1000) / 1000 : null, known_at: iso(last.ingestedAt) };
    }),
  );
  return out.every((x) => x.level_m === null) ? null : { unit: "m", datum_note: "mASD gauges read above their own stage datum, mAOD above Ordnance Datum: compare a gauge only with itself", gauges: out };
}

/** EA water availability for new abstraction at the site, by flow, and how reliably it is available. */
export async function waterSection(sources: SiteSources, site: Site, o: ReportOptions) {
  const read = reader(sources, o.asOf);
  const [classes, rel] = await Promise.all([
    Promise.all(WATER_FLOWS.map((q) => latest(read, "water", `${site.id}.${q}`, o.at, 3 * 24 * H).then((r) => ({ flow: q, row: r })))),
    latest(read, "water_reliability", site.id, o.at, 3 * 24 * H),
  ]);
  if (classes.every((c) => !c.row) && !rel) return null;
  const all = [...classes.flatMap((c) => (c.row ? [c.row] : [])), ...(rel ? [rel] : [])];
  if (all.every((r) => r.quality === "missing")) {
    return { assessed: false, detail: "the EA does not assess water availability for this location (for example the tidal Thames)", known_at: knownAt(all) };
  }
  return {
    assessed: true,
    by_flow: Object.fromEntries(classes.map((c) => [c.flow, c.row && ok(c.row) ? { class: c.row.value, label: WATER_CLASS_LABEL[c.row.value!] } : null])),
    available_pct_of_time_at_least: rel && ok(rel) ? rel.value : null,
    known_at: knownAt(all),
  };
}

/** Heat networks near the site: the outlets for its waste heat. */
export async function heatSection(sources: SiteSources, site: Site, o: ReportOptions) {
  const read = reader(sources, o.asOf);
  const [op, con, plan, dist] = await Promise.all([
    latest(read, "heat", `${site.id}.operational_2km`, o.at, 3 * 24 * H),
    latest(read, "heat", `${site.id}.construction_2km`, o.at, 3 * 24 * H),
    latest(read, "heat", `${site.id}.planned_2km`, o.at, 3 * 24 * H),
    latest(read, "heat_distance", site.id, o.at, 3 * 24 * H),
  ]);
  const rows = [op, con, plan, dist].filter((r): r is Row => r !== null);
  if (rows.length === 0) return null;
  const v = (r: Row | null) => (r && ok(r) ? r.value : null);
  return {
    within_2km: { operational: v(op), under_construction: v(con), planned: v(plan) },
    nearest_live_network_m: v(dist),
    known_at: knownAt(rows),
  };
}
