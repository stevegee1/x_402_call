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

/**
 * Network-fee allowance built into every per-call price (USD on x402, GBP on credits so both rails
 * keep parity). It pays for the gas our facilitator spends to settle each x402 payment; buyers
 * still sign gasless authorisations. Measured on 2026-11-11 with `pnpm gas:cost`: one settle is
 * ~85.7k gas, $0.00106 at Base mainnet's 0.006 gwei. x402 prices include VAT, so $0.001666 of the
 * allowance is ours: about 1.57x today's cost. gas-keeper alerts when the live cost passes that.
 */
export const GAS_ALLOWANCE_USD = "0.002";
export const GAS_ALLOWANCE_GBP_MICROS = 2_000;
/** Gas one USDC transferWithAuthorization settle uses on Base (max of 50 measured settles). */
export const SETTLE_GAS_UNITS = 85_752n;
