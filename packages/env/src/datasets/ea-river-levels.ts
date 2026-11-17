import type { CleanResult, DatasetSpec, Observation } from "../types";

/**
 * Environment Agency river and tidal levels at the gauges nearest our data-centre clusters
 * (sites.ts), every 15 minutes. Read from the latest-readings feed, which covers every gauge
 * (about 4,100, 1.3 MB) in one call; only the measures below are kept.
 *
 * Series = `st_<measure>`: the gauge plus its datum, because levels on different datums don't
 * compare (mASD = above the gauge's stage datum, mAOD = above Ordnance Datum). Chosen 2026-11-17:
 * active gauges with a named river within 5 km of each cluster. Open Government Licence v3.0;
 * attribution EA_ATTRIBUTION. Not for safety-critical use.
 */
export const RIVER_MEASURES = {
  // Slough: Jubilee River at Taplow; Thames at Boveney and Romney Locks.
  st_2603th_masd: "2603TH-level-stage-i-15_min-mASD",
  st_2609th_masd: "2609TH-level-stage-i-15_min-mASD",
  st_2698th_masd: "2698TH-level-stage-i-15_min-mASD",
  // Docklands: tidal Thames at Silvertown and Tower Pier.
  st_0001_maod: "0001-level-tidal_level-i-15_min-mAOD",
  st_0007_maod: "0007-level-tidal_level-i-15_min-mAOD",
  // Hayes: Yeading Brook at Brookside Road and Yeading East; River Crane at Cranford Park.
  st_3650th_masd: "3650TH-level-stage-i-15_min-mASD",
  st_3629th_masd: "3629TH-level-stage-i-15_min-mASD",
  st_3660th_masd: "3660TH-level-stage-i-15_min-mASD",
} as const;
export type RiverSeries = keyof typeof RIVER_MEASURES;

/** Which gauges describe each cluster. */
export const CLUSTER_RIVER_SERIES: Record<"slough" | "docklands" | "hayes", readonly RiverSeries[]> = {
  slough: ["st_2603th_masd", "st_2609th_masd", "st_2698th_masd"],
  docklands: ["st_0001_maod", "st_0007_maod"],
  hayes: ["st_3650th_masd", "st_3629th_masd", "st_3660th_masd"],
};

const SERIES_BY_MEASURE = new Map<string, RiverSeries>(Object.entries(RIVER_MEASURES).map(([s, m]) => [m, s as RiverSeries]));
const PERIOD_MS = 15 * 60_000;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Far outside any river or tide level on these datums: a unit or sensor error. */
const MIN_M = -20;
const MAX_M = 50;

export function cleanRiverLevels(records: readonly unknown[]): CleanResult {
  const byKey = new Map<string, Observation>();
  let dropped = 0;
  let duplicates = 0;
  for (const r of records) {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      dropped++;
      continue;
    }
    const rec = r as Record<string, unknown>;
    const measure = typeof rec.measure === "string" ? rec.measure.split("/").at(-1)! : "";
    const region = SERIES_BY_MEASURE.get(measure);
    if (!region) continue; // a gauge we don't follow: not a dropped row
    const t = typeof rec.dateTime === "string" && ISO_Z.test(rec.dateTime) ? Date.parse(rec.dateTime) : Number.NaN;
    if (!Number.isFinite(t) || t % PERIOD_MS !== 0) {
      dropped++;
      continue;
    }
    const v = rec.value;
    const obs: Observation =
      typeof v === "number" && Number.isFinite(v) && v >= MIN_M && v <= MAX_M
        ? { region, validFrom: t, value: v, quality: "ok", rawValue: null }
        : v === null || v === undefined
          ? { region, validFrom: t, value: null, quality: "missing", rawValue: null }
          : { region, validFrom: t, value: null, quality: "rejected", rawValue: typeof v === "string" ? v : (JSON.stringify(v) ?? String(v)) };
    const key = `${region}|${t}`;
    if (byKey.has(key)) duplicates++;
    byKey.set(key, obs);
  }
  const observations = [...byKey.values()].sort((a, b) => a.validFrom - b.validFrom || (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  return { observations, dropped, duplicates };
}

export const EA_RIVER_LEVELS: DatasetSpec = {
  id: "ea.river_levels",
  unit: "m",
  periodMs: PERIOD_MS,
  regions: Object.keys(RIVER_MEASURES),
  source: "ea",
  resourceId: "/flood-monitoring/data/readings?latest&parameter=level",
  sort: "",
  fetchLimit: 0,
  wholeResource: false,
  clean: cleanRiverLevels,
};
