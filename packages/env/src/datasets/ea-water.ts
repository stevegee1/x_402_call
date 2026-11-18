import { OBSERVED_AT } from "../ea";
import { SITES } from "../sites";
import type { CleanResult, DatasetSpec, Observation } from "../types";

/**
 * Environment Agency "Water Resource Availability and Abstraction Reliability, Cycle 2" (Open
 * Government Licence v3.0), at each of our sites: the WFD water body whose polygon holds the site.
 * It says whether new water could be licensed for abstraction there, which is what a data centre's
 * evaporative cooling or a new borehole needs. Updated about twice a year; we sample it daily, so
 * each day is a point-in-time record of the classification in force.
 *
 * Not the 2021 "water stressed areas" classification: that document is © Environment Agency, all
 * rights reserved (reproduction needs EA permission), so it is not ingested.
 */

export const WATER_PERIOD_MS = 24 * 3_600_000;

export const WATER_ITEMS_PATH =
  "/geoservices/datasets/62514eb5-e9d5-4d96-8b73-a40c5b702d43/ogc/features/v1/collections/Water_Resource_Availability_and_Abstraction_Reliability_Cycle_2/items";

/** Flow percentiles the EA classifies at: Q30 (wet, high flow) to Q95 (dry, low flow). */
export const WATER_FLOWS = ["q30", "q50", "q70", "q95"] as const;

/** EA colour → class. 1 water available for licensing; 2 restricted; 3 not available; 4 heavily modified (judged locally). */
export const WATER_CLASS: Readonly<Record<string, number>> = { Green: 1, Yellow: 2, Red: 3, Grey: 4 };

/** Reliability band → its lower bound, % of time new consumptive abstraction would be available. */
export const RELIABILITY_PCT: Readonly<Record<string, number>> = { "less than 30%": 0, "at least 30%": 30, "at least 50%": 50, "at least 70%": 70, "at least 95%": 95 };

interface Rec {
  site: string;
  feature: Record<string, unknown> | null;
  observedAt: number;
}

function recordsOf(records: readonly unknown[]): { recs: Rec[]; dropped: number } {
  const known = new Set(SITES.map((s) => s.id));
  const recs: Rec[] = [];
  let dropped = 0;
  for (const r of records) {
    const rec = r as { site?: unknown; feature?: unknown; [OBSERVED_AT]?: unknown } | null;
    const observedAt = rec?.[OBSERVED_AT];
    if (!rec || typeof rec.site !== "string" || !known.has(rec.site) || typeof observedAt !== "number" || !Number.isFinite(observedAt) || (rec.feature !== null && typeof rec.feature !== "object")) {
      dropped++;
      continue;
    }
    recs.push({ site: rec.site, feature: rec.feature as Record<string, unknown> | null, observedAt });
  }
  return { recs, dropped };
}

/** One observation from a categorical field: ok when the label is known, missing when no polygon holds the site, rejected otherwise. */
function categorical(region: string, validFrom: number, feature: Record<string, unknown> | null, field: string, table: Readonly<Record<string, number>>): Observation {
  // No polygon at the site: the EA doesn't assess it (missing). A polygon without the field means
  // the source changed shape: rejected, so it is never sold as "not assessed".
  if (feature === null) return { region, validFrom, value: null, quality: "missing", rawValue: null };
  const raw = feature[field];
  if (raw === null || raw === undefined || raw === "") return { region, validFrom, value: null, quality: "rejected", rawValue: `${field} absent` };
  const v = typeof raw === "string" ? table[raw.trim()] : undefined;
  return v === undefined ? { region, validFrom, value: null, quality: "rejected", rawValue: String(raw).slice(0, 200) } : { region, validFrom, value: v, quality: "ok", rawValue: null };
}

const day = (t: number) => Math.floor(t / WATER_PERIOD_MS) * WATER_PERIOD_MS;

export function cleanWaterAvailability(records: readonly unknown[]): CleanResult {
  const { recs, dropped } = recordsOf(records);
  const observations: Observation[] = [];
  for (const r of recs) {
    for (const q of WATER_FLOWS) observations.push(categorical(`${r.site}.${q}`, day(r.observedAt), r.feature, `camscds${q}`, WATER_CLASS));
  }
  return { observations, dropped, duplicates: 0 };
}

export function cleanWaterReliability(records: readonly unknown[]): CleanResult {
  const { recs, dropped } = recordsOf(records);
  return { observations: recs.map((r) => categorical(r.site, day(r.observedAt), r.feature, "resavail", RELIABILITY_PCT)), dropped, duplicates: 0 };
}

const SIX_HOURS = 6 * 3_600_000;

/** Availability class per site and flow percentile. Series: `<site>.q30` … `<site>.q95`. */
export const EA_WATER_AVAILABILITY: DatasetSpec = {
  id: "ea.water_availability",
  unit: "class",
  periodMs: WATER_PERIOD_MS,
  regions: SITES.flatMap((s) => WATER_FLOWS.map((q) => `${s.id}.${q}`)),
  source: "ea_geo",
  resourceId: WATER_ITEMS_PATH,
  sort: "",
  fetchLimit: 0,
  wholeResource: false,
  minFetchIntervalMs: SIX_HOURS,
  checkIntervalMs: 15 * 60_000,
  clean: cleanWaterAvailability,
};

/** Reliability per site: lower bound of the % of time new consumptive abstraction would be available. Series: `<site>`. */
export const EA_WATER_RELIABILITY: DatasetSpec = {
  id: "ea.water_reliability",
  unit: "% of time",
  periodMs: WATER_PERIOD_MS,
  regions: SITES.map((s) => s.id),
  source: "ea_geo",
  resourceId: WATER_ITEMS_PATH,
  sort: "",
  fetchLimit: 0,
  wholeResource: false,
  minFetchIntervalMs: SIX_HOURS,
  checkIntervalMs: 15 * 60_000,
  clean: cleanWaterReliability,
};
