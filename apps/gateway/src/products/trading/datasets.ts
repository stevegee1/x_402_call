import {
  CARBON_INTENSITY,
  DEMAND_FORECAST_2_14D,
  ELEXON_ATTRIBUTION,
  ELEXON_MARKET_INDEX,
  ELEXON_SYSTEM_PRICES,
  EMBEDDED_WIND_SOLAR,
  GENERATION_MIX,
  REGIONAL_CARBON_INTENSITY,
  WIND_FORECAST_14D,
  type DatasetSpec,
} from "@mx/env";

const DAY = 86_400_000;

export interface SourceNote {
  name: string;
  url: string;
  /** The upstream resource we read (NESO CKAN resource id, Elexon API path). */
  resource: string;
  licence: string;
  /** Wording the licence requires wherever the data is shown or sold. */
  attribution: string;
  disclaimer: string;
}

const NESO = (name: string, spec: DatasetSpec): SourceNote => ({
  name,
  url: "https://www.neso.energy/data-portal",
  resource: spec.resourceId,
  licence: "NESO Open Data Licence",
  attribution: "Supported by National Energy SO Open Data",
  disclaimer: "Supplied as is. This service is not provided or endorsed by NESO.",
});

const ELEXON = (name: string, spec: DatasetSpec, now: number): SourceNote => ({
  name,
  url: "https://bmrs.elexon.co.uk",
  resource: spec.resourceId,
  licence: "Elexon BMRS data, use cleared with Elexon",
  attribution: ELEXON_ATTRIBUTION(new Date(now).getUTCFullYear()),
  disclaimer: "Supplied as is. This service is not provided or endorsed by Elexon.",
});

export interface TradingDataset {
  /** URL segment, stable forever once sold: /v1/trading/<key>/… */
  key: string;
  spec: DatasetSpec;
  title: string;
  /** forecast: values ahead of now that NESO revises. outturn: estimates of what happened. price: settlement prices, revised through settlement runs. */
  kind: "forecast" | "outturn" | "price";
  description: string;
  /**
   * How far back the gateway keeps every version in memory. Older reads go to Postgres. Long enough
   * that "latest" is always a memory read (generation mix lags upstream by about 12 days).
   */
  memoryMs: number;
  source(now: number): SourceNote;
}

/**
 * Everything the trading feed sells: every half-hourly series ingest-env records from NESO and
 * Elexon. Environment Agency data is not here: it is site data (flood, rivers), sold by site
 * intelligence, and the EA forbids safety-critical use.
 */
export const TRADING_DATASETS: readonly TradingDataset[] = [
  {
    key: "carbon_intensity",
    spec: CARBON_INTENSITY,
    title: "Country carbon intensity forecast",
    kind: "forecast",
    description: "Half-hourly gCO2/kWh forecast for England, Scotland and Wales, 48 h ahead, every revision kept.",
    memoryMs: 2 * DAY,
    source: () => NESO("NESO Country Carbon Intensity Forecast", CARBON_INTENSITY),
  },
  {
    key: "regional_carbon_intensity",
    spec: REGIONAL_CARBON_INTENSITY,
    title: "Regional carbon intensity forecast",
    kind: "forecast",
    description: "Half-hourly gCO2/kWh forecast for the 14 GB distribution regions, 48 h ahead.",
    memoryMs: 2 * DAY,
    source: () => NESO("NESO Regional Carbon Intensity Forecast", REGIONAL_CARBON_INTENSITY),
  },
  {
    key: "embedded_wind_solar",
    spec: EMBEDDED_WIND_SOLAR,
    title: "Embedded wind and solar forecast",
    kind: "forecast",
    description: "Half-hourly MW forecast of embedded (distribution-connected) wind and solar output, with installed capacity.",
    memoryMs: 2 * DAY,
    source: () => NESO("NESO Embedded Wind and Solar Forecasts", EMBEDDED_WIND_SOLAR),
  },
  {
    key: "wind_forecast_14d",
    spec: WIND_FORECAST_14D,
    title: "14-day wind forecast",
    kind: "forecast",
    description: "Half-hourly MW forecast of transmission-connected wind output 14 days ahead, with capacity.",
    memoryMs: 2 * DAY,
    source: () => NESO("NESO 14 Days Ahead Wind Forecasts", WIND_FORECAST_14D),
  },
  {
    key: "demand_forecast_2_14d",
    spec: DEMAND_FORECAST_2_14D,
    title: "2-14 day demand forecast",
    kind: "forecast",
    description: "Half-hourly MW national demand forecast from 2 to 14 days ahead.",
    memoryMs: 2 * DAY,
    source: () => NESO("NESO 2-14 Days Ahead National Demand Forecast", DEMAND_FORECAST_2_14D),
  },
  {
    key: "generation_mix",
    spec: GENERATION_MIX,
    title: "Historic generation mix",
    kind: "outturn",
    description: "Half-hourly estimated MW output by fuel (gas, wind, nuclear, imports, ...). NESO publishes it about 12 days after the fact and revises it.",
    memoryMs: 21 * DAY,
    source: () => NESO("NESO Historic GB Generation Mix", GENERATION_MIX),
  },
  {
    key: "system_prices",
    spec: ELEXON_SYSTEM_PRICES,
    title: "Imbalance (system) prices",
    kind: "price",
    description: "System sell and system buy price per settlement period, £/MWh, every settlement-run revision kept.",
    memoryMs: 2 * DAY,
    source: (now) => ELEXON("Elexon system prices", ELEXON_SYSTEM_PRICES, now),
  },
  {
    key: "market_index",
    spec: ELEXON_MARKET_INDEX,
    title: "Market index price",
    kind: "price",
    description: "Market index (wholesale) price per settlement period, £/MWh.",
    memoryMs: 2 * DAY,
    source: (now) => ELEXON("Elexon market index data", ELEXON_MARKET_INDEX, now),
  },
];

export const TRADING_KEYS = TRADING_DATASETS.map((d) => d.key);

export function tradingDataset(key: string): TradingDataset | undefined {
  return TRADING_DATASETS.find((d) => d.key === key);
}
