/**
 * The real adapter against the real contracts: an anvil fork of Base mainnet, Uniswap v3's
 * SwapRouter02 and QuoterV2, Circle's USDC and Chainlink's ETH/USD feed. Proves the swap encoding,
 * the unwrap to native ETH, the exact-approval reset and the oracle guard on live liquidity.
 *
 *   pnpm --filter @mx/gas-keeper test:fork          # FORK_RPC_URL overrides https://mainnet.base.org
 */
import { Metrics } from "@mx/shared";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, pad, parseEther, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS } from "../src/addresses";
import { assertChain, assertEoas, createKeeperChain } from "../src/chain";
import { Keeper, SwapError, TOPUP_GAS_UNITS, usdcForWei, WebhookAlerts, type Limits } from "../src/keeper";

const FORK_RPC = process.env.FORK_RPC_URL ?? "https://mainnet.base.org";
const C = CONTRACTS["eip155:8453"];
// A fresh key per run. Never anvil's well-known dev keys: on Base mainnet they carry EIP-7702
// sweeper delegations, which is exactly what assertEoas guards against (tested below).
const KEEPER_KEY = generatePrivateKey();
const LEAKED_DEV_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const KEEPER = privateKeyToAccount(KEEPER_KEY).address;
const FACILITATOR = "0x9F03ad7f2C2c00D4668Dcead2CA3b03d1a0552f5" as Address;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let anvil: ChildProcess;
let rpc: string;
const pub = () => createPublicClient({ chain: base, transport: http(rpc) });
const call = (method: string, params: unknown[]) => pub().request({ method: method as never, params: params as never });
const usdcOf = (who: Address) => pub().readContract({ address: C.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  rpc = `http://127.0.0.1:${port}`;
  // Gentle on the public RPC: it rate-limits bursts (429), and anvil retries with backoff.
  anvil = spawn("anvil", ["--fork-url", FORK_RPC, "--port", String(port), "--silent", "--compute-units-per-second", "25", "--retries", "10", "--fork-retry-backoff", "2000"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await pub().getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await call("anvil_setBalance", [KEEPER, `0x${parseEther("0.001").toString(16)}`]);
  await call("anvil_setBalance", [FACILITATOR, `0x${parseEther("0.002").toString(16)}`]);
  // FiatToken v2.2 keeps balances in mapping slot 9, packed with a blacklist flag in the top bit
  // (anvil_dealERC20 can't find it): write 40 USDC with the flag clear.
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [KEEPER, 9n]));
  await call("anvil_setStorageAt", [C.usdc, slot, pad(toHex(40_000_000n), { size: 32 })]);
  expect(await usdcOf(KEEPER)).toBe(40_000_000n);
});

afterAll(() => {
  anvil?.kill();
});

function limitsWith(over: Partial<Limits> = {}): Limits {
  return {
    facilitator: FACILITATOR,
    facilitatorMinWei: parseEther("0.001"),
    triggerWei: parseEther("0.003"),
    targetWei: parseEther("0.01"),
    keeperReserveWei: parseEther("0.001"),
    maxUsdcPerTopup: 50_000_000n,
    maxUsdcPerDay: 100_000_000n,
    maxSlippageBps: 100,
    // The fork's clock starts at the fork block; allow the feed's normal heartbeat plus slack.
    priceMaxAgeS: 7200,
    floatLowUsdc: 10_000_000n,
    failAlertTicks: 3,
    ...over,
  };
}

function keeperWith(over: Partial<Limits> = {}) {
  const chain = createKeeperChain({ network: "eip155:8453", rpcUrl: rpc, privateKey: KEEPER_KEY, poolFee: 500, receiptTimeoutMs: 30_000 });
  const metrics = new Metrics();
  const alerts = new WebhookAlerts({ network: "eip155:8453", metrics, log: silent });
  return { chain, metrics, keeper: new Keeper(chain, limitsWith(over), { metrics, log: silent, alerts }) };
}

describe("gas-keeper on a Base mainnet fork", () => {
  it("talks to Base mainnet: chain id, a live Chainlink price, and a pool quote near it", async () => {
    const { chain } = keeperWith();
    await assertChain(chain, "eip155:8453");
    await assertEoas(chain, [KEEPER, FACILITATOR]);
    await expect(assertEoas(chain, [LEAKED_DEV_ADDRESS])).rejects.toThrow(/EIP-7702 delegation/);
    const { priceE8 } = await chain.ethUsd();
    expect(Number(priceE8) / 1e8).toBeGreaterThan(100);
    expect(await chain.sequencer()).toMatchObject({ up: true }); // Chainlink's L2 sequencer uptime feed on Base
    expect(await chain.settleL1FeeWei()).toBeGreaterThan(0n);
    expect(await chain.hasPendingTx()).toBe(false);
    const quote = await chain.quoteUsdcForEth(parseEther("0.008"));
    const oracle = usdcForWei(parseEther("0.008"), priceE8);
    expect(Number(quote)).toBeGreaterThan(Number(oracle) * 0.98);
    expect(Number(quote)).toBeLessThan(Number(oracle) * 1.02);
  });

  it("refuses the real pool's quote when it is above the oracle ceiling", async () => {
    // The real quoter, against an oracle 5% below the live Chainlink price: whichever way the
    // market leans today, the pool's quote is now above the 1% ceiling and the swap must be refused.
    const { chain } = keeperWith();
    const live = await chain.ethUsd();
    const lowOracle = { ...chain, ethUsd: async () => ({ ...live, priceE8: (live.priceE8 * 95n) / 100n }) };
    const keeper = new Keeper(lowOracle, limitsWith(), { metrics: new Metrics(), log: silent, alerts: new WebhookAlerts({ network: "eip155:8453", metrics: new Metrics(), log: silent }) });
    const before = await usdcOf(KEEPER);
    expect(await keeper.tick()).toEqual({ ok: true, plan: "blocked", reason: "quote_above_oracle" });
    expect(await usdcOf(KEEPER)).toBe(before);
    expect(await chain.ethBalance(FACILITATOR)).toBe(parseEther("0.002"));
  });

  it("swaps USDC for native ETH on Uniswap and refills the facilitator to exactly the target", async () => {
    const { keeper, chain, metrics } = keeperWith();
    const { priceE8 } = await chain.ethUsd();
    const gasPrice = await chain.gasPriceWei();
    expect(await keeper.tick()).toEqual({ ok: true, plan: "swap" });

    expect(await chain.ethBalance(FACILITATOR)).toBe(parseEther("0.01"));
    // The swap bought this top-up's own gas too (approve, swap+unwrap, allowance reset, send), so the
    // keeper ends with at least its full reserve; and the real gas fit the budget plan() allows.
    const keeperEth = await chain.ethBalance(KEEPER);
    expect(keeperEth).toBeGreaterThanOrEqual(parseEther("0.001"));
    expect(keeperEth).toBeLessThan(parseEther("0.001") + TOPUP_GAS_UNITS * gasPrice);

    const spent = 40_000_000n - (await usdcOf(KEEPER));
    expect(keeper.spentDay()).toBe(spent); // the receipt's Transfer log matches the balance change
    const swappedEth = parseEther("0.008") + TOPUP_GAS_UNITS * gasPrice;
    expect(spent).toBeLessThanOrEqual((usdcForWei(swappedEth, priceE8) * 10_100n) / 10_000n);
    expect(metrics.get("gas_keeper_usdc_spent_total")).toBeCloseTo(Number(spent) / 1e6, 6);

    const allowance = await pub().readContract({ address: C.usdc, abi: erc20Abi, functionName: "allowance", args: [KEEPER, C.router] });
    expect(allowance).toBe(0n); // no standing approval left behind
    expect(await pub().getBalance({ address: C.router })).toBe(0n); // unwrap delivered everything
  });

  it("is idle once the facilitator is at target", async () => {
    const { keeper } = keeperWith();
    expect(await keeper.tick()).toEqual({ ok: true, plan: "idle" });
  });

  it("withdraws an approval left behind (e.g. a crash between approve and reset) before anything else", async () => {
    const { keeper, chain } = keeperWith();
    await call("anvil_impersonateAccount", [KEEPER]);
    const hash = (await pub().request({ method: "eth_sendTransaction" as never, params: [{ from: KEEPER, to: C.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.router, 5_000_000n] }) }] as never })) as `0x${string}`;
    expect((await pub().waitForTransactionReceipt({ hash })).status).toBe("success");
    await call("anvil_stopImpersonatingAccount", [KEEPER]);
    expect(await chain.routerAllowance()).toBe(5_000_000n);
    expect(await keeper.tick()).toEqual({ ok: true, plan: "idle" });
    expect(await chain.routerAllowance()).toBe(0n);
  });

  it("a swap that would revert fails before broadcast: SwapError not_sent, nonce unchanged", async () => {
    const { chain } = keeperWith();
    expect(await chain.routerAllowance()).toBe(0n); // no approval: the router can't pull USDC
    const nonce = await pub().getTransactionCount({ address: KEEPER });
    const err = await chain.swapUsdcForEth(parseEther("0.001"), 1_000_000n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwapError);
    expect((err as SwapError).outcome).toBe("not_sent");
    expect(await pub().getTransactionCount({ address: KEEPER })).toBe(nonce);
  });

  it("stopped right after a real swap: the next process only withdraws the allowance and sends, never swaps again", async () => {
    await call("anvil_setBalance", [FACILITATOR, `0x${parseEther("0.002").toString(16)}`]);
    await call("anvil_setBalance", [KEEPER, `0x${parseEther("0.001").toString(16)}`]);
    const { chain } = keeperWith();
    let keeperA!: Keeper;
    // SIGTERM lands while the swap is mining: no reset, no send.
    const stopping = { ...chain, swapUsdcForEth: async (eth: bigint, max: bigint) => {
      const r = await chain.swapUsdcForEth(eth, max);
      keeperA.requestStop();
      return r;
    } };
    keeperA = new Keeper(stopping, limitsWith(), { metrics: new Metrics(), log: silent, alerts: new WebhookAlerts({ network: "eip155:8453", metrics: new Metrics(), log: silent }) });
    expect(await keeperA.tick()).toEqual({ ok: false, error: "stopped after swap; the next start sends the ETH" });
    const usdcAfterSwap = await usdcOf(KEEPER);
    expect(await chain.routerAllowance()).toBeGreaterThan(0n); // exactOutput left some unspent

    const { keeper: keeperB } = keeperWith(); // the next deployment
    expect(await keeperB.tick()).toEqual({ ok: true, plan: "send" });
    expect(await chain.ethBalance(FACILITATOR)).toBe(parseEther("0.01"));
    expect(await chain.routerAllowance()).toBe(0n);
    expect(await usdcOf(KEEPER)).toBe(usdcAfterSwap); // no second swap
    expect(await chain.ethBalance(KEEPER)).toBeGreaterThanOrEqual(parseEther("0.0005")); // at least half its reserve
  });

  it("sends ETH it already holds without touching USDC (recovery path)", async () => {
    await call("anvil_setBalance", [FACILITATOR, `0x${parseEther("0.001").toString(16)}`]);
    await call("anvil_setBalance", [KEEPER, `0x${parseEther("0.02").toString(16)}`]);
    const { keeper, chain } = keeperWith();
    const usdcBefore = await usdcOf(KEEPER);
    expect(await keeper.tick()).toEqual({ ok: true, plan: "send" });
    expect(await chain.ethBalance(FACILITATOR)).toBe(parseEther("0.01"));
    expect(await usdcOf(KEEPER)).toBe(usdcBefore);
  });
});
