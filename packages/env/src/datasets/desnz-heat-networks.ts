import { OBSERVED_AT } from "../ea";
import { bngDistanceM } from "../geo";
import { SITES, type Site } from "../sites";
import type { CleanResult, DatasetSpec, Observation } from "../types";

/**
 * DESNZ Heat Networks Planning Database (Open Government Licence v3.0): every district and communal
 * heat network in UK planning, with its status and British National Grid location. Released
 * quarterly. For each of our sites we store how many networks are near it by status, and how far
 * the nearest live one is: the raw material of a heat-reuse score (a data centre's waste heat needs
 * a network to go into).
 *
 * Sampled daily (period = UTC day of the read), so a site report for any past day reads the
 * release that was current then.
 *
 * Series per site:
 *   `<site>.operational_2km`   networks in operation within 2 km
 *   `<site>.construction_2km`  under construction within 2 km
 *   `<site>.planned_2km`       consented and awaiting construction, or applied for, within 2 km
 *   `<site>.nearest_live_m`    metres to the nearest network operating or under construction
 *                              (stored as DESNZ_HEAT_NETWORK_DISTANCE, series `<site>`: a dataset has one unit)
 * Northern Ireland rows are excluded (not on the GB grid); rows with no valid location are dropped.
 */

export const HEAT_PERIOD_MS = 24 * 3_600_000;
export const HEAT_RADIUS_M = 2_000;
export const HNPD_PACKAGE = "desnz-heat-networks-planning-database";
export const HNPD_ATTRIBUTION = "Contains public sector information licensed under the Open Government Licence v3.0 (DESNZ Heat Networks Planning Database)";

export const HEAT_METRICS = ["operational_2km", "construction_2km", "planned_2km", "nearest_live_m"] as const;

type Stage = "operational" | "construction" | "planned" | null;
/** `Development Status (short)` → stage. Withdrawn, refused, abandoned, revised and the rest count as none. */
function stageOf(status: unknown): Stage {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "operational") return "operational";
  if (s === "under construction") return "construction";
  if (s === "awaiting construction" || s === "application submitted") return "planned";
  return null;
}

/** BNG coordinate: finite, within the GB grid's extent. */
function coord(v: unknown, max: number): number | null {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "").trim()) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 && n < max && (typeof v !== "string" || v.trim() !== "") ? n : null;
}

export function cleanHeatNetworks(records: readonly unknown[], sites: readonly Site[] = SITES): CleanResult {
  const networks: Array<{ e: number; n: number; stage: Exclude<Stage, null> }> = [];
  let dropped = 0;
  let observedAt: number | null = null;
  for (const r of records) {
    const rec = r as Record<string, unknown> | null;
    const t = rec?.[OBSERVED_AT];
    if (!rec || typeof t !== "number" || !Number.isFinite(t)) {
      dropped++;
      continue;
    }
    observedAt ??= t;
    if (typeof rec.Country === "string" && rec.Country.trim().toLowerCase() === "northern ireland") continue;
    const stage = stageOf(rec["Development Status (short)"]);
    if (stage === null) continue; // not a network that exists or is coming: no bearing on heat reuse
    const e = coord(rec["X-coordinate"], 700_000);
    const n = coord(rec["Y-coordinate"], 1_300_000);
    if (e === null || n === null) {
      dropped++;
      continue;
    }
    networks.push({ e, n, stage });
  }
  if (observedAt === null) return { observations: [], dropped, duplicates: 0 };
  const validFrom = Math.floor(observedAt / HEAT_PERIOD_MS) * HEAT_PERIOD_MS;
  const observations: Observation[] = [];
  const ok = (region: string, value: number): Observation => ({ region, validFrom, value, quality: "ok", rawValue: null });
  for (const s of sites) {
    const count = { operational: 0, construction: 0, planned: 0 };
    let nearest = Infinity;
    for (const net of networks) {
      const d = bngDistanceM(s.easting, s.northing, net.e, net.n);
      if (d <= HEAT_RADIUS_M) count[net.stage]++;
      if (net.stage !== "planned" && d < nearest) nearest = d;
    }
    observations.push(ok(`${s.id}.operational_2km`, count.operational), ok(`${s.id}.construction_2km`, count.construction), ok(`${s.id}.planned_2km`, count.planned));
    observations.push(Number.isFinite(nearest) ? ok(`${s.id}.nearest_live_m`, Math.round(nearest)) : { region: `${s.id}.nearest_live_m`, validFrom, value: null, quality: "missing", rawValue: null });
  }
  return { observations, dropped, duplicates: 0 };
}

const COUNT_METRICS = HEAT_METRICS.filter((m) => m !== "nearest_live_m");
const only = (r: CleanResult, keep: (region: string) => boolean): CleanResult => ({ ...r, observations: r.observations.filter((o) => keep(o.region)) });

const base = {
  periodMs: HEAT_PERIOD_MS,
  source: "ckan_csv" as const,
  resourceId: HNPD_PACKAGE,
  sort: "",
  fetchLimit: 0,
  wholeResource: false,
  minFetchIntervalMs: 6 * 3_600_000,
  // A quarterly release: asking data.gov.uk every 15 min is plenty.
  checkIntervalMs: 15 * 60_000,
};

/** Heat networks near each site, by stage (one dataset has one unit: these are counts). */
export const DESNZ_HEAT_NETWORKS: DatasetSpec = {
  ...base,
  id: "desnz.heat_networks",
  unit: "count",
  regions: SITES.flatMap((s) => COUNT_METRICS.map((m) => `${s.id}.${m}`)),
  clean: (records) => only(cleanHeatNetworks(records), (r) => !r.endsWith(".nearest_live_m")),
};

/** Metres from each site to the nearest heat network operating or under construction. Series: `<site>`. */
export const DESNZ_HEAT_NETWORK_DISTANCE: DatasetSpec = {
  ...base,
  id: "desnz.heat_network_distance",
  unit: "m",
  regions: SITES.map((s) => s.id),
  clean: (records) => {
    const r = only(cleanHeatNetworks(records), (region) => region.endsWith(".nearest_live_m"));
    return { ...r, observations: r.observations.map((o) => ({ ...o, region: o.region.slice(0, -".nearest_live_m".length) })) };
  },
};
