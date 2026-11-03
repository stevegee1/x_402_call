import type { Address } from "viem";

/**
 * Canonical ERC-8004 registries (github.com/erc-8004/erc-8004-contracts README, cross-checked with
 * erc-8004.quicknode.com/docs/contracts and read on chain, 2026-11-03). They are upgradeable
 * proxies, which is one reason identity may only ever loosen limits.
 */
export const ERC8004_REGISTRIES: Record<string, { identity: Address; reputation: Address }> = {
  "eip155:8453": { identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" },
  "eip155:84532": { identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e", reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" },
};

/** ERC-8004 agentRegistry identifier: eip155:<chainId>:<identityRegistry>. */
export const agentRegistryId = (network: string, identity: Address) => `${network}:${identity}`;
