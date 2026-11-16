import { makeCleaner } from "../clean";
import { datePart, HALF_HOUR_MS, intOf, settlementPeriodStart } from "../time";
import type { DatasetSpec } from "../types";

/**
 * NESO Embedded Wind and Solar Forecast: MW forecast for wind and solar connected to the
 * distribution networks (invisible to the transmission system), with the installed capacity each
 * forecast assumes. About 13 days ahead in settlement periods. Each run replaces the whole
 * resource, so the live resource only ever holds the newest run.
 *
 * Placement: SETTLEMENT_DATE + SETTLEMENT_PERIOD give the period. DATE_GMT + TIME_GMT label the
 * period's END in UTC (checked 2026-11-16: SP 1 of 2026-11-17 is "00:30"; SP 1 of 2025-07-15, in
 * BST, is "2025-07-14 23:30"). A row whose two labels disagree is dropped, so a format change
 * stops the data instead of misplacing it.
 */
export function embeddedPeriodStart(rec: Record<string, unknown>): number | null {
  const date = datePart(rec.SETTLEMENT_DATE);
  const sp = intOf(rec.SETTLEMENT_PERIOD);
  if (date === null || sp === null) return null;
  const start = settlementPeriodStart(date, sp);
  const gmtDate = datePart(rec.DATE_GMT);
  const gmtTime = typeof rec.TIME_GMT === "string" ? /^(\d{2}):(\d{2})(:00)?$/.exec(rec.TIME_GMT) : null;
  if (start === null || gmtDate === null || gmtTime === null) return null;
  const [, hh, mm] = gmtTime;
  if (+hh! > 23 || +mm! > 59) return null;
  const end = Date.parse(`${gmtDate}T${hh}:${mm}:00Z`);
  return end - HALF_HOUR_MS === start ? start : null;
}

const COLUMNS = [
  // Embedded wind capacity is ~6 GW and solar ~24 GW (2026). The ceilings leave room for growth
  // and catch unit or scaling errors.
  { region: "wind", field: "EMBEDDED_WIND_FORECAST", min: 0, max: 50_000 },
  { region: "wind_capacity", field: "EMBEDDED_WIND_CAPACITY", min: 0, max: 50_000 },
  { region: "solar", field: "EMBEDDED_SOLAR_FORECAST", min: 0, max: 150_000 },
  { region: "solar_capacity", field: "EMBEDDED_SOLAR_CAPACITY", min: 0, max: 150_000 },
];

export const cleanEmbeddedWindSolar = makeCleaner({ periodMs: HALF_HOUR_MS, periodStart: embeddedPeriodStart, columns: COLUMNS });

export const EMBEDDED_WIND_SOLAR: DatasetSpec = {
  id: "neso.embedded_wind_solar_forecast",
  unit: "MW",
  periodMs: HALF_HOUR_MS,
  regions: COLUMNS.map((c) => c.region),
  resourceId: "db6c038f-98af-4570-ab60-24d71ebd0ae5",
  sort: "SETTLEMENT_DATE desc, SETTLEMENT_PERIOD desc",
  fetchLimit: 2_000, // the resource holds ~600 rows (one run)
  wholeResource: true,
  clean: cleanEmbeddedWindSolar,
};
