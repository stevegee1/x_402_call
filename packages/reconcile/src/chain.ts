import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { ChainTransfer } from "./core";

/** Canonical USDC per network: the asset the gateway's x402 requirements name (@x402/evm defaults). */
export const USDC: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

export const publicClient = (rpcUrl: string) => createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) });

export interface ScannedTransfer extends ChainTransfer {
  block: bigint;
}

/**
 * Scans USDC transfers into `payTo` over [fromBlock, toBlock], pairing each with the EIP-3009 nonce
 * it consumed. Public RPCs cap eth_getLogs ranges, so the scan is chunked, and a chunk that errors
 * is halved and retried down to a single block before giving up.
 */
export async function scanTransfers(
  client: Pick<PublicClient, "getContractEvents">,
  asset: Address,
  payTo: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunk = 2_000n,
): Promise<ScannedTransfer[]> {
  const out: ScannedTransfer[] = [];
  let start = fromBlock;
  let size = chunk;
  while (start <= toBlock) {
    const end = start + size - 1n > toBlock ? toBlock : start + size - 1n;
    try {
      const [transfers, used] = await Promise.all([
        client.getContractEvents({ address: asset, abi: USDC_ABI, eventName: "Transfer", args: { to: payTo }, fromBlock: start, toBlock: end, strict: true }),
        client.getContractEvents({ address: asset, abi: USDC_ABI, eventName: "AuthorizationUsed", fromBlock: start, toBlock: end, strict: true }),
      ]);
      // FiatToken (and MockUSDC) emit AuthorizationUsed immediately before the Transfer it authorises.
      const usedAt = new Map(used.map((u) => [`${u.transactionHash}:${u.logIndex}`, u.args]));
      for (const t of transfers) {
        const auth = usedAt.get(`${t.transactionHash}:${t.logIndex - 1}`);
        const nonce = auth && getAddress(auth.authorizer) === getAddress(t.args.from) ? (auth.nonce as Hex) : null;
        out.push({ tx: t.transactionHash, from: t.args.from.toLowerCase(), value: t.args.value, nonce, block: t.blockNumber });
      }
      start = end + 1n;
      size = chunk;
    } catch (e) {
      if (size === 1n) throw e;
      size = size / 2n; // range too large for this RPC: retry the same start with a smaller window
    }
  }
  return out;
}
