import { createWalletClient, encodeFunctionData, erc20Abi, http, isAddressEqual, keccak256, parseAbi, parseEventLogs, publicActions, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { CONTRACTS, type SupportedNetwork } from "./addresses";
import { SETTLE_TX_BYTES, SwapError, type KeeperChain } from "./keeper";

const oracleAbi = parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]);
/** OP-stack GasPriceOracle predeploy. */
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F" as const;
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);
const quoterAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const routerAbi = parseAbi([
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
/** SwapRouter02's Constants.ADDRESS_THIS: the router holds the WETH until unwrapWETH9 in the same call. */
const ROUTER_SELF = "0x0000000000000000000000000000000000000002" as const;
const DEADLINE_S = 300n;

export interface ChainOptions {
  network: SupportedNetwork;
  rpcUrl: string;
  privateKey: Hex;
  poolFee: number;
  /** Bound on each receipt wait. */
  receiptTimeoutMs?: number;
}

export function createKeeperChain(o: ChainOptions): KeeperChain & { chainId(): Promise<number> } {
  const c = CONTRACTS[o.network];
  // No nonce manager: the keeper sends one transaction at a time and waits for it, so each takes its
  // nonce from the node. A local counter would wedge every later transaction if one were dropped.
  const account = privateKeyToAccount(o.privateKey);
  const client = createWalletClient({
    account,
    chain: o.network === "eip155:8453" ? base : baseSepolia,
    transport: http(o.rpcUrl, { timeout: 15_000, retryCount: 2 }),
  }).extend(publicActions);
  const timeout = o.receiptTimeoutMs ?? 60_000;

  const mined = async (hash: Hex, what: string) => {
    const r = await client.waitForTransactionReceipt({ hash, timeout });
    if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
    return r;
  };
  const usdcBalance = () => client.readContract({ address: c.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const allowance = () => client.readContract({ address: c.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, c.router] });

  return {
    address: account.address,
    chainId: () => client.getChainId(),
    ethBalance: (who: Address) => client.getBalance({ address: who }),
    hasCode: async (who: Address) => ((await client.getCode({ address: who })) ?? "0x") !== "0x",
    usdcBalance,
    async hasPendingTx() {
      const [latest, pending] = await Promise.all([
        client.getTransactionCount({ address: account.address, blockTag: "latest" }),
        client.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      return pending > latest;
    },
    async sequencer() {
      if (!c.sequencerFeed) return null;
      const [, answer, startedAt] = await client.readContract({ address: c.sequencerFeed, abi: feedAbi, functionName: "latestRoundData" });
      return { up: answer === 0n, sinceS: Number(startedAt) };
    },
    settleL1FeeWei: () => client.readContract({ address: GAS_PRICE_ORACLE, abi: oracleAbi, functionName: "getL1FeeUpperBound", args: [SETTLE_TX_BYTES] }),
    routerAllowance: allowance,
    async resetAllowance() {
      const tx = await client.writeContract({ address: c.usdc, abi: erc20Abi, functionName: "approve", args: [c.router, 0n] });
      await mined(tx, "allowance reset");
      return tx;
    },
    async ethUsd() {
      const [, answer, , updatedAt] = await client.readContract({ address: c.ethUsdFeed, abi: feedAbi, functionName: "latestRoundData" });
      return { priceE8: answer, updatedAt: Number(updatedAt) };
    },
    gasPriceWei: () => client.getGasPrice(),
    async quoteUsdcForEth(ethOutWei) {
      const { result } = await client.simulateContract({
        address: c.quoter,
        abi: quoterAbi,
        functionName: "quoteExactOutputSingle",
        args: [{ tokenIn: c.usdc, tokenOut: c.weth, amount: ethOutWei, fee: o.poolFee, sqrtPriceLimitX96: 0n }],
      });
      return result[0];
    },
    async approveRouter(usdcMax) {
      // Exact approval, never unlimited: the router can take at most this swap's ceiling. The keeper
      // resets whatever is left after the swap, and again at the start of any later tick.
      const tx = await client.writeContract({ address: c.usdc, abi: erc20Abi, functionName: "approve", args: [c.router, usdcMax] });
      await mined(tx, "approve");
      return tx;
    },
    async swapUsdcForEth(ethOutWei, usdcMax) {
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_S;
      const swap = encodeFunctionData({
        abi: routerAbi,
        functionName: "exactOutputSingle",
        args: [{ tokenIn: c.usdc, tokenOut: c.weth, fee: o.poolFee, recipient: ROUTER_SELF, amountOut: ethOutWei, amountInMaximum: usdcMax, sqrtPriceLimitX96: 0n }],
      });
      const unwrap = encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [ethOutWei, account.address] });
      const data = encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [deadline, [swap, unwrap]] });
      // Classified by phase, not by error type: until the signed bytes are handed to the node nothing
      // can have reached the chain ("not_sent"); from then on it may have ("unknown"). Signing here
      // gives the hash before broadcasting, so a failed submission can still be tracked.
      let serialized: Hex;
      try {
        const request = await client.prepareTransactionRequest({ account, chain: client.chain, to: c.router, data });
        serialized = await account.signTransaction(request as Parameters<typeof account.signTransaction>[0]);
      } catch (e) {
        throw new SwapError("not_sent", `swap (before broadcast): ${(e as Error).message}`, { cause: e });
      }
      const tx = keccak256(serialized);
      let receipt;
      try {
        await client.sendRawTransaction({ serializedTransaction: serialized });
        receipt = await client.waitForTransactionReceipt({ hash: tx, timeout });
      } catch (e) {
        throw new SwapError("unknown", `swap ${tx}: ${(e as Error).message}`, { cause: e });
      }
      if (receipt.status !== "success") throw new SwapError("reverted", `swap reverted: ${tx}`);
      // What the swap itself took, from its own logs: a float refill landing meanwhile can't skew it.
      const usdcSpent = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
        .filter((e) => isAddressEqual(e.address, c.usdc) && isAddressEqual(e.args.from, account.address))
        .reduce((sum, e) => sum + e.args.value, 0n);
      return { tx, usdcSpent };
    },
    async sendEth(to, valueWei) {
      const tx = await client.sendTransaction({ to, value: valueWei });
      await mined(tx, "send");
      return tx;
    },
  };
}

/** Both wallets must be plain EOAs (see KeeperChain.hasCode); refuse to start otherwise. */
export async function assertEoas(chain: Pick<KeeperChain, "hasCode">, addresses: Address[]) {
  for (const a of addresses) if (await chain.hasCode(a)) throw new Error(`${a} has code (a contract or an EIP-7702 delegation): ETH sent there may be forwarded. Use a fresh key.`);
}

/** Refuse to run against an RPC for a different chain. */
export async function assertChain(chain: { chainId(): Promise<number> }, network: SupportedNetwork) {
  const got = await chain.chainId();
  if (got !== CONTRACTS[network].chainId) throw new Error(`RPC chain id ${got} does not match NETWORK ${network} (expected ${CONTRACTS[network].chainId})`);
}
