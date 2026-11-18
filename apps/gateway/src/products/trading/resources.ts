import type { PricedResource, ResourceParameter } from "../../platform/product";
import { TRADING_DATASETS, TRADING_KEYS } from "./datasets";

const dataset: ResourceParameter = {
  name: "dataset",
  in: "path",
  required: true,
  description: "Dataset key (see GET /v1/trading/datasets)",
  schema: { type: "string", enum: TRADING_KEYS },
};

const series: ResourceParameter = {
  name: "series",
  in: "path",
  required: true,
  description: "Series within the dataset, e.g. england, wind, ssp (see GET /v1/trading/datasets)",
  schema: { type: "string", enum: [...new Set(TRADING_DATASETS.flatMap((d) => d.spec.regions))] },
};

/**
 * Trading feed price list: Grid's price scale (decided 2026-11-18). USD is VAT-inclusive, settled
 * in USDC, and includes the network-fee allowance; credits are GBP net of VAT.
 */
export const TRADING_RESOURCES: readonly PricedResource[] = [
  {
    id: "trading.latest",
    path: "/:dataset/latest",
    summary: "Every series in a dataset: its newest period at or before now, with the latest version and when we first knew it",
    pricing: { kind: "fixed", priceUsd: "0.012", creditsGbpMicros: 10_000 },
    parameters: [dataset],
  },
  {
    id: "trading.history",
    path: "/:dataset/:series/history",
    summary:
      "Point-in-time history: for each period in a range (past or ahead), the version that stood at as_of (default now), with when we first knew it. A range with no recorded data is refused (404 no_history) and not charged",
    pricing: { kind: "fixed", priceUsd: "0.052", creditsGbpMicros: 42_000 },
    parameters: [
      dataset,
      series,
      { name: "from", in: "query", required: true, description: "Range start, ISO 8601 with a zone (e.g. 2026-11-17T00:00:00Z)", schema: { type: "string", format: "date-time" } },
      { name: "to", in: "query", description: "Range end (exclusive), at most 7 days after from; default from + 24 h", schema: { type: "string", format: "date-time" } },
      { name: "as_of", in: "query", description: "Knowledge time: only versions known by then (default now; not in the future)", schema: { type: "string", format: "date-time" } },
    ],
  },
  {
    id: "trading.revisions",
    path: "/:dataset/:series/revisions",
    summary: "Every version of one period, oldest first: how the source's value for it changed. A period with no recorded version is refused (404 no_history) and not charged",
    pricing: { kind: "fixed", priceUsd: "0.022", creditsGbpMicros: 17_000 },
    parameters: [dataset, series, { name: "period", in: "query", required: true, description: "Period start, ISO 8601 with a zone, on :00 or :30", schema: { type: "string", format: "date-time" } }],
  },
];

/** Push (sessions enabled): the dataset's live view on connect, then again whenever a new version lands. */
export const TRADING_STREAM_RESOURCES: readonly PricedResource[] = [
  {
    id: "trading.stream",
    path: "/:dataset/stream",
    summary: "Server-sent events: the dataset's live view (each series' newest period at or before now, and every period ahead) on connect and on each new version. Charged per event from an x402 session",
    pricing: { kind: "fixed", priceUsd: "0.012", creditsGbpMicros: 10_000 },
    parameters: [dataset],
    rails: ["session"],
  },
];
