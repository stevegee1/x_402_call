import { makeCleaner } from "../clean";
import { datePart, HALF_HOUR_MS, intOf, parseNaiveUtc, settlementPeriodStart } from "../time";
import type { DatasetSpec } from "../types";

/**
 * NESO 14 Days Ahead Wind Forecast: MW forecast for transmission-metered wind (the wind NESO sees
 * directly; embedded wind is the other dataset), with the capacity it assumes. Published about 8
 * times a day, and each run replaces the whole resource.
 *
 * Placement: Date + Settlement_Period give the period, and `Datetime` must equal its start in UTC
 * (like NESO's other naive timestamps). Verified in GMT only, when UTC and UK local time agree. We
 * deliberately accept one reading, not either: in BST the two are an hour apart, so accepting both
 * would let a wrong settlement period through. If NESO labels local time in BST, every row is
 * dropped from 2027-03-28 and the drop-ratio warning fires; nothing is stored an hour out.
 *
 * Each fetch must hold one run (one ForecastDateTime). A read taken while NESO replaces the
 * resource could mix two runs; that fetch is refused whole, and the poller reads again.
 */
export function wind14dPeriodStart(rec: Record<string, unknown>): number | null {
  const date = datePart(rec.Date);
  const sp = intOf(rec.Settlement_Period);
  if (date === null || sp === null) return null;
  const start = settlementPeriodStart(date, sp);
  return start !== null && parseNaiveUtc(rec.Datetime) === start ? start : null;
}

export const wind14dRun = (rec: Record<string, unknown>) => (parseNaiveUtc(rec.ForecastDateTime) === null ? null : String(rec.ForecastDateTime));

const COLUMNS = [
  // Transmission wind capacity is ~26 GW (2026); the ceiling leaves room for the offshore build-out.
  { region: "wind", field: "Wind_Forecast", min: 0, max: 150_000 },
  { region: "wind_capacity", field: "Capacity", min: 0, max: 150_000 },
];

export const cleanWindForecast14d = makeCleaner({ periodMs: HALF_HOUR_MS, periodStart: wind14dPeriodStart, run: wind14dRun, columns: COLUMNS });

export const WIND_FORECAST_14D: DatasetSpec = {
  id: "neso.wind_forecast_14d",
  unit: "MW",
  periodMs: HALF_HOUR_MS,
  regions: COLUMNS.map((c) => c.region),
  resourceId: "93c3048e-1dab-4057-a2a9-417540583929",
  sort: "Datetime desc",
  fetchLimit: 2_000, // the resource holds ~670 rows (one run)
  wholeResource: true,
  clean: cleanWindForecast14d,
};
