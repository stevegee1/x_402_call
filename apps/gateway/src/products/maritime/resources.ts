import { REGION_IDS } from "@mx/shared";
import type { PricedResource, ResourceParameter } from "../../platform/product";

const region: ResourceParameter = {
  name: "region",
  in: "path",
  required: true,
  description: "dover = Dover Strait, rotterdam = Port of Rotterdam approaches, panama = Panama Canal approaches",
  schema: { type: "string", enum: REGION_IDS },
};

/**
 * Maritime price list. x402 prices are USD, VAT-inclusive, settled in USDC; credits prices are
 * GBP net of VAT (VAT charged at top-up). Ids are stable: they are stored on payments, usage rows
 * and journal memos.
 */
export const MARITIME_RESOURCES: readonly PricedResource[] = [
  {
    id: "maritime.vessels",
    path: "/:region/vessels",
    summary: "Current vessel snapshot for a region (filterable)",
    pricing: { kind: "fixed", priceUsd: "0.033", creditsGbpMicros: 25_000 },
    parameters: [
      region,
      { name: "category", in: "query", description: "Ship category, e.g. tanker, cargo, passenger", schema: { type: "string" } },
      { name: "min_speed_kn", in: "query", description: "Minimum speed over ground in knots", schema: { type: "number", minimum: 0 } },
      { name: "bbox", in: "query", description: "minLon,minLat,maxLon,maxLat", schema: { type: "string" } },
    ],
    legacyPaths: ["/v1/:region/vessels"],
  },
  {
    id: "maritime.vessel",
    path: "/:region/vessels/:mmsi",
    summary: "Single vessel latest state and recent track",
    pricing: { kind: "fixed", priceUsd: "0.033", creditsGbpMicros: 25_000 },
    parameters: [region, { name: "mmsi", in: "path", required: true, description: "Maritime Mobile Service Identity", schema: { type: "integer" } }],
    legacyPaths: ["/v1/:region/vessels/:mmsi"],
  },
  {
    id: "maritime.density",
    path: "/:region/density",
    summary: "H3-binned traffic density (moving vs anchored)",
    pricing: { kind: "fixed", priceUsd: "0.033", creditsGbpMicros: 25_000 },
    parameters: [region],
    legacyPaths: ["/v1/:region/density"],
  },
  {
    id: "maritime.queue",
    path: "/:region/queue",
    summary: "Anchorage queue: vessels waiting, wait-time stats, draught constraints",
    pricing: { kind: "fixed", priceUsd: "0.066", creditsGbpMicros: 50_000 },
    parameters: [region],
    legacyPaths: ["/v1/:region/queue"],
  },
  {
    id: "maritime.anomalies",
    path: "/:region/anomalies",
    summary: "AIS gaps (vessels going dark), position jumps, loitering",
    pricing: { kind: "fixed", priceUsd: "0.066", creditsGbpMicros: 50_000 },
    parameters: [region],
    legacyPaths: ["/v1/:region/anomalies"],
  },
];
