import { parseAbi, type Address } from "viem";

/** The ERC-8004 reads we use (signatures as in the EIP; verified against the live Base Sepolia registries). */
export const IDENTITY_ABI = parseAbi(["function getAgentWallet(uint256 agentId) view returns (address)"]);
export const REPUTATION_ABI = parseAbi([
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

export interface ReputationSummary {
  count: number;
  /** Mean of non-revoked feedback from the given reviewers, as a float on their scale. */
  score: number;
}

/** Read-only view of the ERC-8004 registries; a seam for tests. */
export interface AgentRegistry {
  /** The verified payment wallet bound to the agent (zero address if unset or after a transfer). */
  agentWallet(agentId: bigint): Promise<Address>;
  reputation(agentId: bigint, reviewers: readonly Address[], tag: string): Promise<ReputationSummary>;
}

/** The one client capability we need (any viem PublicClient satisfies it, whatever its chain type). */
export interface ContractReader {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

export function createAgentRegistry(client: ContractReader, registries: { identity: Address; reputation: Address }): AgentRegistry {
  return {
    agentWallet: async (agentId) =>
      (await client.readContract({ address: registries.identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [agentId] })) as Address,
    async reputation(agentId, reviewers, tag) {
      const [count, value, decimals] = (await client.readContract({
        address: registries.reputation,
        abi: REPUTATION_ABI,
        functionName: "getSummary",
        args: [agentId, [...reviewers], tag, ""],
      })) as readonly [bigint, bigint, number];
      return { count: Number(count), score: Number(value) / 10 ** decimals };
    },
  };
}
