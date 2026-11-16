import { makeCleaner } from "../clean";
import { HALF_HOUR_MS, parseNaiveUtc } from "../time";
import type { DatasetSpec } from "../types";

/** Above any carbon intensity GB has recorded; anything outside [0, MAX] is a source error. */
export const MAX_CARBON_INTENSITY = 2_000;

/** NESO's carbon intensity resources label each half-hour by its start, as naive UTC in `datetime`. */
export const carbonPeriodStart = (rec: Record<string, unknown>) => parseNaiveUtc(rec.datetime);

/**
 * NESO Country Carbon Intensity Forecast: half-hourly gCO2/kWh for England, Scotland and Wales,
 * about 48 h ahead. NESO overwrites each half-hour's row as the forecast is revised (the resource's
 * unique key is `datetime`), so it keeps no old versions.
 */
const COLUMNS = [
  { region: "england", field: "England" },
  { region: "scotland", field: "Scotland" },
  { region: "wales", field: "Wales" },
].map((c) => ({ ...c, min: 0, max: MAX_CARBON_INTENSITY }));

export const cleanCarbonIntensity = makeCleaner({ periodMs: HALF_HOUR_MS, periodStart: carbonPeriodStart, columns: COLUMNS });

export const CARBON_INTENSITY: DatasetSpec = {
  id: "neso.carbon_intensity",
  unit: "gCO2/kWh",
  periodMs: HALF_HOUR_MS,
  regions: COLUMNS.map((c) => c.region),
  resourceId: "e032e7aa-dea5-4695-80d6-19739142021d",
  sort: "datetime desc",
  fetchLimit: 200, // ~100 h: the ~50 h forward horizon plus ~2 days of recent periods
  wholeResource: false,
  clean: cleanCarbonIntensity,
};
