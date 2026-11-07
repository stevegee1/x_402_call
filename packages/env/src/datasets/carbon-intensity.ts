import type { CleanResult, DatasetSpec, Observation, Quality } from "../types";

/**
 * NESO Country Carbon Intensity Forecast: half-hourly gCO2/kWh for England, Scotland and Wales,
 * about 48 h ahead. NESO overwrites each half-hour's row as the forecast is revised (the resource's
 * unique key is `datetime`), so it keeps no old versions.
 */
const REGIONS = ["england", "scotland", "wales"] as const;
const COLUMN: Record<(typeof REGIONS)[number], string> = { england: "England", scotland: "Scotland", wales: "Wales" };

const PERIOD_MS = 30 * 60_000;
/** Above any carbon intensity GB has recorded; anything outside [0, MAX] is a source error. */
const MAX_PLAUSIBLE = 2_000;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function cleanValue(raw: unknown): { value: number | null; quality: Quality; rawValue: string | null } {
  if (raw === null || raw === undefined || raw === "") return { value: null, quality: "missing", rawValue: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (Number.isFinite(n) && n >= 0 && n <= MAX_PLAUSIBLE) return { value: n, quality: "ok", rawValue: null };
  return { value: null, quality: "rejected", rawValue: typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw) };
}

export function cleanCarbonIntensity(records: readonly unknown[]): CleanResult {
  const byStart = new Map<number, Record<string, unknown>>();
  let dropped = 0;
  let duplicates = 0;
  for (const r of records) {
    if (!r || typeof r !== "object") {
      dropped++;
      continue;
    }
    const rec = r as Record<string, unknown>;
    const dt = rec.datetime;
    // NESO labels periods in UTC without an offset.
    const start = typeof dt === "string" && DATETIME.test(dt) ? Date.parse(`${dt}Z`) : Number.NaN;
    if (!Number.isFinite(start) || start % PERIOD_MS !== 0) {
      dropped++;
      continue;
    }
    if (byStart.has(start)) duplicates++;
    byStart.set(start, rec);
  }
  const observations: Observation[] = [];
  for (const start of [...byStart.keys()].sort((a, b) => a - b)) {
    const rec = byStart.get(start)!;
    for (const region of REGIONS) observations.push({ region, validFrom: start, ...cleanValue(rec[COLUMN[region]]) });
  }
  return { observations, dropped, duplicates };
}

export const CARBON_INTENSITY: DatasetSpec = {
  id: "neso.carbon_intensity",
  unit: "gCO2/kWh",
  periodMs: PERIOD_MS,
  regions: REGIONS,
  resourceId: "e032e7aa-dea5-4695-80d6-19739142021d",
  fetchLimit: 200, // ~100 h: the ~50 h forward horizon plus ~2 days of recent periods
  clean: cleanCarbonIntensity,
};
