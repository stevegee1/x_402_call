/**
 * Single source of truth for paid endpoints. Both payment rails price from here:
 *  - x402: USD-denominated, settled in USDC (6 decimals). VAT-inclusive (anonymous buyers, see MVP.md §VAT).
 *  - Fiat credits: GBP micros (1 GBP = 1_000_000), net of VAT (B2B accounts; VAT charged at top-up).
 */
export type EndpointId = "vessels" | "vessel" | "density" | "queue" | "anomalies";

export interface PaidEndpoint {
  id: EndpointId;
  /** Hono route pattern. */
  path: string;
  description: string;
  priceUsd: string;
  creditsGbpMicros: number;
}

export const PAID_ENDPOINTS: Record<EndpointId, PaidEndpoint> = {
  vessels: {
    id: "vessels",
    path: "/v1/:region/vessels",
    description: "Live vessel snapshot for a region (filterable)",
    priceUsd: "0.033",
    creditsGbpMicros: 25_000,
  },
  vessel: {
    id: "vessel",
    path: "/v1/:region/vessels/:mmsi",
    description: "Single vessel latest state and recent track",
    priceUsd: "0.033",
    creditsGbpMicros: 25_000,
  },
  density: {
    id: "density",
    path: "/v1/:region/density",
    description: "H3-binned traffic density (moving vs anchored)",
    priceUsd: "0.033",
    creditsGbpMicros: 25_000,
  },
  queue: {
    id: "queue",
    path: "/v1/:region/queue",
    description: "Anchorage queue: vessels waiting, wait-time stats, draught constraints",
    priceUsd: "0.066",
    creditsGbpMicros: 50_000,
  },
  anomalies: {
    id: "anomalies",
    path: "/v1/:region/anomalies",
    description: "AIS gaps (vessels going dark), position jumps, loitering",
    priceUsd: "0.066",
    creditsGbpMicros: 50_000,
  },
};

/** USD decimal string -> USDC atomic units (6 dp). Exact; no floating point. */
export function usdToUsdcAtomic(usd: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd);
  if (!m) throw new Error(`invalid USD amount: ${usd}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export interface CreditPack {
  id: string;
  label: string;
  netGbpMicros: number;
}

export const CREDIT_PACKS: Record<string, CreditPack> = {
  starter: { id: "starter", label: "Starter £20", netGbpMicros: 20_000_000 },
  team: { id: "team", label: "Team £100", netGbpMicros: 100_000_000 },
  scale: { id: "scale", label: "Scale £500", netGbpMicros: 500_000_000 },
};

export const formatGbp = (micros: number) => `£${(micros / 1_000_000).toFixed(2)}`;
