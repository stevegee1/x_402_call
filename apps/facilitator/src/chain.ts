import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, http, nonceManager, publicActions, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { NETWORK_CHAIN_IDS, type Config } from "./config";

/** What the HTTP layer needs to know about the chain, for readiness and metrics. */
export interface ChainProbe {
  readonly address: Address;
  chainId(): Promise<number>;
  gasBalanceWei(): Promise<bigint>;
  /** What a mined transaction cost us: L2 execution (gasUsed x effective price) plus the OP-stack L1 data fee. */
  txFee(hash: `0x${string}`): Promise<{ gasUsed: bigint; feeWei: bigint }>;
}

export function createChain(cfg: Pick<Config, "NETWORK" | "RPC_URL" | "FACILITATOR_PRIVATE_KEY" | "CONFIRMATION_TIMEOUT_MS">) {
  // The nonce manager hands out transaction nonces locally, so concurrent settles from this process
  // don't race for the same pending nonce. Run one replica per key; scale out with more keys.
  const account = privateKeyToAccount(cfg.FACILITATOR_PRIVATE_KEY as `0x${string}`, { nonceManager });
  const client = createWalletClient({
    account,
    chain: cfg.NETWORK === "eip155:8453" ? base : baseSepolia,
    transport: http(cfg.RPC_URL, { timeout: 10_000, retryCount: 2 }),
  }).extend(publicActions);

  const signer = toFacilitatorEvmSigner(
    {
      address: account.address,
      readContract: (a) => client.readContract(a as Parameters<typeof client.readContract>[0]),
      verifyTypedData: (a) => client.verifyTypedData(a as Parameters<typeof client.verifyTypedData>[0]),
      writeContract: (a) => client.writeContract(a as Parameters<typeof client.writeContract>[0]),
      sendTransaction: (a) => client.sendTransaction(a as Parameters<typeof client.sendTransaction>[0]),
      waitForTransactionReceipt: (a) => client.waitForTransactionReceipt(a),
      getCode: (a) => client.getCode(a),
    },
    { confirmationTimeoutMs: cfg.CONFIRMATION_TIMEOUT_MS },
  );

  const probe: ChainProbe = {
    address: account.address,
    chainId: () => client.getChainId(),
    gasBalanceWei: () => client.getBalance({ address: account.address }),
    txFee: async (hash) => {
      const r = await client.getTransactionReceipt({ hash });
      const l1Fee = (r as { l1Fee?: bigint | null }).l1Fee ?? 0n;
      return { gasUsed: r.gasUsed, feeWei: r.gasUsed * r.effectiveGasPrice + l1Fee };
    },
  };
  return { signer, probe };
}

/** Refuse to run against an RPC for a different chain: a mainnet key on a testnet RPC (or vice versa) is an incident. */
export async function assertChain(probe: ChainProbe, network: keyof typeof NETWORK_CHAIN_IDS) {
  const got = await probe.chainId();
  const want = NETWORK_CHAIN_IDS[network];
  if (got !== want) throw new Error(`RPC chain id ${got} does not match NETWORK ${network} (expected ${want})`);
}
