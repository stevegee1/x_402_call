import { createPublicClient, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

export interface AuthorizationChecker {
  /** True if the EIP-3009 authorization nonce has been consumed on-chain (i.e. the payment settled). */
  isUsed(asset: string, authorizer: string, nonce: string): Promise<boolean>;
}

const ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Resolves "indeterminate" settlements (facilitator timeout) by reading USDC state directly. */
export function createAuthorizationChecker(network: string, rpcUrl: string): AuthorizationChecker {
  const client = createPublicClient({ chain: network === "eip155:8453" ? base : baseSepolia, transport: http(rpcUrl, { timeout: 5_000 }) });
  return {
    isUsed: (asset, authorizer, nonce) =>
      client.readContract({ address: asset as Address, abi: ABI, functionName: "authorizationState", args: [authorizer as Address, nonce as Hex] }),
  };
}
