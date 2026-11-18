import type { DatasetSpec } from "../types";
import { CARBON_INTENSITY } from "./carbon-intensity";
import { EA_FLOOD_WARNINGS } from "./ea-flood-warnings";
import { EA_RIVER_LEVELS } from "./ea-river-levels";
import { ELEXON_MARKET_INDEX, ELEXON_SYSTEM_PRICES } from "./elexon-prices";
import { DEMAND_FORECAST_2_14D } from "./demand-forecast-2-14d";
import { EMBEDDED_WIND_SOLAR } from "./embedded-wind-solar";
import { GENERATION_MIX } from "./generation-mix";
import { REGIONAL_CARBON_INTENSITY } from "./regional-carbon-intensity";
import { WIND_FORECAST_14D } from "./wind-forecast-14d";
import { EA_WATER_AVAILABILITY, EA_WATER_RELIABILITY } from "./ea-water";
import { DESNZ_HEAT_NETWORK_DISTANCE, DESNZ_HEAT_NETWORKS } from "./desnz-heat-networks";

/**
 * Every dataset ingest-env can store. The first one is polled first at boot, and ingest-env gives
 * its requests priority in the NESO client's queue: carbon intensity backs the paid grid product.
 */
export const NESO_DATASETS: readonly DatasetSpec[] = [
  CARBON_INTENSITY,
  REGIONAL_CARBON_INTENSITY,
  EMBEDDED_WIND_SOLAR,
  WIND_FORECAST_14D,
  DEMAND_FORECAST_2_14D,
  GENERATION_MIX,
];

/** Every dataset ingest-env can store, from every source. */
export const ENV_DATASETS: readonly DatasetSpec[] = [
  ...NESO_DATASETS,
  EA_FLOOD_WARNINGS,
  EA_RIVER_LEVELS,
  ELEXON_SYSTEM_PRICES,
  ELEXON_MARKET_INDEX,
  EA_WATER_AVAILABILITY,
  EA_WATER_RELIABILITY,
  DESNZ_HEAT_NETWORKS,
  DESNZ_HEAT_NETWORK_DISTANCE,
];

export { CARBON_INTENSITY, cleanCarbonIntensity } from "./carbon-intensity";
export { EA_FLOOD_WARNINGS, cleanFloodWarnings, FLOOD_PERIOD_MS } from "./ea-flood-warnings";
export { EA_RIVER_LEVELS, cleanRiverLevels, RIVER_MEASURES, CLUSTER_RIVER_SERIES, type RiverSeries } from "./ea-river-levels";
export { REGIONAL_CARBON_INTENSITY, cleanRegionalCarbonIntensity } from "./regional-carbon-intensity";
export { EMBEDDED_WIND_SOLAR, cleanEmbeddedWindSolar, embeddedPeriodStart } from "./embedded-wind-solar";
export { WIND_FORECAST_14D, cleanWindForecast14d, wind14dPeriodStart, wind14dRun } from "./wind-forecast-14d";
export { DEMAND_FORECAST_2_14D, cleanDemandForecast214d, demand214dPeriodStart } from "./demand-forecast-2-14d";
export { GENERATION_MIX, cleanGenerationMix } from "./generation-mix";
export { ELEXON_SYSTEM_PRICES, ELEXON_MARKET_INDEX, cleanSystemPrices, cleanMarketIndex } from "./elexon-prices";
export { EA_WATER_AVAILABILITY, EA_WATER_RELIABILITY, cleanWaterAvailability, cleanWaterReliability, WATER_CLASS, RELIABILITY_PCT, WATER_FLOWS, WATER_ITEMS_PATH, WATER_PERIOD_MS } from "./ea-water";
export { DESNZ_HEAT_NETWORKS, DESNZ_HEAT_NETWORK_DISTANCE, cleanHeatNetworks, HEAT_METRICS, HEAT_RADIUS_M, HEAT_PERIOD_MS, HNPD_PACKAGE, HNPD_ATTRIBUTION } from "./desnz-heat-networks";
