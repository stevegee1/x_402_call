/** USDC contracts the SDK will pay with. Anything else is denied (USD value would be unknown). */
export const USDC_BY_NETWORK: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

export const EXPLORER_TX: Record<string, string> = {
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/",
};

export function isUsdc(network: string, asset: string): boolean {
  return USDC_BY_NETWORK[network]?.toLowerCase() === asset.toLowerCase();
}

/** USDC atomic (6dp) -> USD number. Safe for per-request amounts. */
export const usdcAtomicToUsd = (atomic: string | bigint) => Number(BigInt(atomic)) / 1e6;
