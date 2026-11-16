import { makeCleaner } from "../clean";
import { HALF_HOUR_MS } from "../time";
import type { DatasetSpec } from "../types";
import { carbonPeriodStart, MAX_CARBON_INTENSITY } from "./carbon-intensity";

/**
 * NESO Regional Carbon Intensity Forecast: half-hourly gCO2/kWh for the 14 GB distribution regions,
 * about 48 h ahead. Same shape and overwrite behaviour as the country forecast (unique key
 * `datetime`, updated in place), so revisions exist only in our store. Slough is in "south_england".
 */
const FIELDS: ReadonlyArray<[string, string]> = [
  ["north_scotland", "North Scotland"],
  ["south_scotland", "South Scotland"],
  ["north_west_england", "North West England"],
  ["north_east_england", "North East England"],
  ["yorkshire", "Yorkshire"],
  ["north_wales_merseyside", "North Wales and Merseyside"],
  ["south_wales", "South Wales"],
  ["west_midlands", "West Midlands"],
  ["east_midlands", "East Midlands"],
  ["east_england", "East England"],
  ["south_west_england", "South West England"],
  ["south_england", "South England"],
  ["london", "London"],
  ["south_east_england", "South East England"],
];
const COLUMNS = FIELDS.map(([region, field]) => ({ region, field, min: 0, max: MAX_CARBON_INTENSITY }));

export const cleanRegionalCarbonIntensity = makeCleaner({ periodMs: HALF_HOUR_MS, periodStart: carbonPeriodStart, columns: COLUMNS });

export const REGIONAL_CARBON_INTENSITY: DatasetSpec = {
  id: "neso.regional_carbon_intensity",
  unit: "gCO2/kWh",
  periodMs: HALF_HOUR_MS,
  regions: COLUMNS.map((c) => c.region),
  resourceId: "c16b0e19-c02a-44a8-ba05-4db2c0545a2a",
  sort: "datetime desc",
  fetchLimit: 200, // ~100 h: the ~50 h forward horizon plus ~2 days of recent periods
  wholeResource: false,
  clean: cleanRegionalCarbonIntensity,
};
