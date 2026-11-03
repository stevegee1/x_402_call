import type { PricedResource, ResourceParameter } from "../../platform/product";
import { COUNTRIES } from "./source";

const country: ResourceParameter = {
  name: "country",
  in: "path",
  required: true,
  description: "GB country whose grid carbon intensity to read (NESO country forecast)",
  schema: { type: "string", enum: COUNTRIES },
};

/** Grid price list (same conventions as maritime: USD VAT-inclusive in USDC; credits GBP net of VAT). */
export const GRID_RESOURCES: readonly PricedResource[] = [
  {
    id: "grid.intensity",
    path: "/:country/intensity",
    summary: "Grid carbon intensity now (gCO2/kWh), the next half-hour, and how now compares with the next 24 h",
    pricing: { kind: "fixed", priceUsd: "0.01", creditsGbpMicros: 8_000 },
    parameters: [country],
  },
  {
    id: "grid.forecast",
    path: "/:country/forecast",
    summary: "Half-hourly carbon intensity forecast from now",
    pricing: { kind: "fixed", priceUsd: "0.02", creditsGbpMicros: 15_000 },
    parameters: [country, { name: "hours", in: "query", description: "Horizon in hours (1-48, default 24)", schema: { type: "integer", minimum: 1, maximum: 48 } }],
  },
  {
    id: "grid.window",
    path: "/:country/window",
    summary: "Cleanest time to run a job: the lowest-carbon contiguous window, and the saving versus starting now",
    pricing: { kind: "fixed", priceUsd: "0.05", creditsGbpMicros: 40_000 },
    parameters: [
      country,
      { name: "duration_h", in: "query", required: true, description: "Job length in hours, in half-hour steps (0.5-12)", schema: { type: "number", minimum: 0.5, maximum: 12 } },
      { name: "within_h", in: "query", description: "Must finish within this many hours (duration_h-48, default 24)", schema: { type: "number", minimum: 0.5, maximum: 48 } },
    ],
  },
];
