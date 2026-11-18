import {
  DESNZ_HEAT_NETWORK_DISTANCE,
  DESNZ_HEAT_NETWORKS,
  EA_ATTRIBUTION,
  EA_FLOOD_WARNINGS,
  EA_GEO_ATTRIBUTION,
  EA_RIVER_LEVELS,
  EA_WATER_AVAILABILITY,
  EA_WATER_RELIABILITY,
  ELEXON_ATTRIBUTION,
  ELEXON_MARKET_INDEX,
  ELEXON_SYSTEM_PRICES,
  HNPD_ATTRIBUTION,
  REGIONAL_CARBON_INTENSITY,
  SITE_FLOOD_SERIES,
  type DatasetSpec,
  type EnvCache,
  type EnvHistory,
} from "@mx/env";

const MIN = 60_000;
const H = 60 * MIN;

/** Every dataset a site report reads. */
export type InputKey = "carbon" | "system_prices" | "market_index" | "flood" | "rivers" | "water" | "water_reliability" | "heat" | "heat_distance";

export interface SiteInput {
  key: InputKey;
  spec: DatasetSpec;
  /** Series the gateway must hold in memory for this dataset (flood warnings are an open set upstream). */
  series: readonly string[];
  /**
   * Ingest must have fetched this dataset successfully within this long, or the site is stale and
   * nothing is sold (I1). Half-hourly and 15-minute data: 20 min (ingest reads them at least every
   * 10). Daily site data: 30 h (read every 6 h; a day of failures is tolerated, two are not).
   */
  maxIngestAgeMs: number;
  /** How far back the gateway keeps every version in memory; older reads go to Postgres. */
  memoryMs: number;
}

const LIVE = 20 * MIN;
const DAILY = 30 * H;
const TWO_DAYS = 48 * H;

export const SITE_INPUTS: readonly SiteInput[] = [
  { key: "carbon", spec: REGIONAL_CARBON_INTENSITY, series: REGIONAL_CARBON_INTENSITY.regions, maxIngestAgeMs: LIVE, memoryMs: TWO_DAYS },
  { key: "system_prices", spec: ELEXON_SYSTEM_PRICES, series: ELEXON_SYSTEM_PRICES.regions, maxIngestAgeMs: LIVE, memoryMs: TWO_DAYS },
  { key: "market_index", spec: ELEXON_MARKET_INDEX, series: ELEXON_MARKET_INDEX.regions, maxIngestAgeMs: LIVE, memoryMs: TWO_DAYS },
  { key: "flood", spec: EA_FLOOD_WARNINGS, series: SITE_FLOOD_SERIES, maxIngestAgeMs: LIVE, memoryMs: TWO_DAYS },
  { key: "rivers", spec: EA_RIVER_LEVELS, series: EA_RIVER_LEVELS.regions, maxIngestAgeMs: LIVE, memoryMs: TWO_DAYS },
  { key: "water", spec: EA_WATER_AVAILABILITY, series: EA_WATER_AVAILABILITY.regions, maxIngestAgeMs: DAILY, memoryMs: 3 * 24 * H },
  { key: "water_reliability", spec: EA_WATER_RELIABILITY, series: EA_WATER_RELIABILITY.regions, maxIngestAgeMs: DAILY, memoryMs: 3 * 24 * H },
  { key: "heat", spec: DESNZ_HEAT_NETWORKS, series: DESNZ_HEAT_NETWORKS.regions, maxIngestAgeMs: DAILY, memoryMs: 3 * 24 * H },
  { key: "heat_distance", spec: DESNZ_HEAT_NETWORK_DISTANCE, series: DESNZ_HEAT_NETWORK_DISTANCE.regions, maxIngestAgeMs: DAILY, memoryMs: 3 * 24 * H },
];

/** What the product reads for one dataset. */
export interface SiteInputSource {
  cache: EnvCache;
  history: EnvHistory;
  /** When ingest last fetched this dataset successfully (epoch ms), live. */
  ingestLastSuccessAt(): number | null;
  /** When ingest last fetched it successfully at or before `at` (a store read), for point-in-time reports. */
  ingestSuccessAsOf(at: number): Promise<number | null>;
}

export type SiteSources = ReadonlyMap<InputKey, SiteInputSource>;

/** The licence lines every site response carries, one per source used. */
export function siteSources(now: number) {
  return [
    { name: "NESO Regional Carbon Intensity Forecast", licence: "NESO Open Data Licence", attribution: "Supported by National Energy SO Open Data", disclaimer: "Not provided or endorsed by NESO." },
    { name: "Elexon BMRS system prices and market index", licence: "Elexon BMRS data, use cleared with Elexon", attribution: ELEXON_ATTRIBUTION(new Date(now).getUTCFullYear()), disclaimer: "Not provided or endorsed by Elexon." },
    { name: "Environment Agency flood warnings and river levels (real-time API)", licence: "Open Government Licence v3.0", attribution: EA_ATTRIBUTION, disclaimer: "Not for safety-critical use: check the EA's own flood warnings service." },
    { name: "Environment Agency Water Resource Availability and Abstraction Reliability (Cycle 2)", licence: "Open Government Licence v3.0", attribution: EA_GEO_ATTRIBUTION, disclaimer: "Indicative; abstraction needs an EA licence decision." },
    { name: "DESNZ Heat Networks Planning Database", licence: "Open Government Licence v3.0", attribution: HNPD_ATTRIBUTION, disclaimer: "Planning status as last recorded by DESNZ." },
  ];
}
