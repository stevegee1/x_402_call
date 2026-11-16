import { makeCleaner } from "../clean";
import { addDays, datePart, HALF_HOUR_MS, intOf, londonWallClock, parseNaiveUtc } from "../time";
import type { DatasetSpec } from "../types";

/**
 * NESO 2-14 Days Ahead Half Hourly Demand Forecast: national demand in MW. Each run replaces the
 * whole resource. NESO archives only the cardinal-point version of this forecast, so the
 * half-hourly history exists only in our store.
 *
 * Placement: `GDATETIME` is the period END in UTC ("G" for GMT): the day's last row is DATE
 * 2026-11-18, CTIME 2400, GDATETIME 2026-11-19T00:00. DATE + CTIME are the same end as UK local
 * wall-clock time. Checked in winter only, when the two agree, so each row is cross-checked: a row
 * whose UTC end doesn't show the local end on a UK clock is dropped. If BST proves either
 * assumption wrong, the data stops and the poller warns, rather than storing it an hour out.
 */
export function demand214dPeriodStart(rec: Record<string, unknown>): number | null {
  const end = parseNaiveUtc(rec.GDATETIME);
  const date = datePart(rec.DATE);
  const ctime = intOf(rec.CTIME);
  if (end === null || date === null || ctime === null) return null;
  const hh = Math.floor(ctime / 100);
  const mm = ctime % 100;
  if (ctime < 0 || hh > 24 || (mm !== 0 && mm !== 30) || (hh === 24 && mm !== 0) || (hh === 0 && mm === 0)) return null;
  const localEnd = hh === 24 ? `${addDays(date, 1)}T00:00` : `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return londonWallClock(end) === localEnd ? end - HALF_HOUR_MS : null;
}

const COLUMNS = [
  // GB national demand has never exceeded ~60 GW or fallen near zero; 5-100 GW catches unit errors.
  { region: "gb", field: "NATIONALDEMAND", min: 5_000, max: 100_000 },
];

export const cleanDemandForecast214d = makeCleaner({ periodMs: HALF_HOUR_MS, periodStart: demand214dPeriodStart, columns: COLUMNS });

export const DEMAND_FORECAST_2_14D: DatasetSpec = {
  id: "neso.demand_forecast_2_14d",
  unit: "MW",
  periodMs: HALF_HOUR_MS,
  regions: COLUMNS.map((c) => c.region),
  resourceId: "7c0411cd-2714-4bb5-a408-adb065edf34d",
  sort: "GDATETIME desc",
  fetchLimit: 2_000, // the resource holds ~620 rows (one run)
  wholeResource: true,
  clean: cleanDemandForecast214d,
};
