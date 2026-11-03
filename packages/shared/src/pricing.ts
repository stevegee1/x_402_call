/**
 * Money helpers shared by the gateway, SDK and scripts. Product price lists live with each product
 * (e.g. apps/gateway/src/products/maritime/resources.ts).
 */

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
