import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, http, nonceManager, parseAbi, publicActions, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { freePort, httpOk, ROOT, startService, waitFor, type Service } from "./proc";

/** Pinned toolchain (see .github/workflows/ci.yml); a different anvil may behave differently. */
export const FOUNDRY_VERSION = "1.8.5";
/** The gateway's production config for eip155:84532 uses this asset (@x402/evm default). */
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** Canonical Multicall3, predeployed on Base and Base Sepolia; @x402/evm batches its diagnostics through it. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** Canonical ERC-8004 registries on Base Sepolia (the gateway's defaults for eip155:84532). */
export const ERC8004_IDENTITY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const ERC8004_REPUTATION: Address = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const CHAIN_ID = 84532;

/** anvil's well-known dev keys (public; local chain only). #0 mints, #1 is the facilitator's gas wallet. */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  facilitator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  /** Gives ERC-8004 feedback; configured as the gateways' trusted reviewer. */
  reviewer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const satisfies Record<string, Hex>;

export const USDC_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

/** One deployer account per process, with a local nonce manager: concurrent mints must not reuse a nonce. */
const deployerAccount = privateKeyToAccount(ANVIL_KEYS.deployer, { nonceManager });

export function clients(rpcUrl: string) {
  const transport = http(rpcUrl, { timeout: 10_000 });
  return {
    public: createPublicClient({ chain: baseSepolia, transport }),
    test: createTestClient({ chain: baseSepolia, mode: "anvil", transport }),
    deployer: createWalletClient({ chain: baseSepolia, transport, account: deployerAccount }).extend(publicActions),
  };
}

export interface Anvil {
  rpcUrl: string;
  service: Service;
}

export function assertFoundryVersion() {
  let out: string;
  try {
    out = execFileSync("anvil", ["--version"], { encoding: "utf8" });
  } catch {
    throw new Error(`anvil not found on PATH. Install the pinned Foundry: foundryup --install v${FOUNDRY_VERSION}`);
  }
  if (!out.includes(`anvil Version: ${FOUNDRY_VERSION}`) && !out.includes(`anvil ${FOUNDRY_VERSION}`)) {
    throw new Error(`anvil ${FOUNDRY_VERSION} required, found: ${out.split("\n")[0]}. Run: foundryup --install v${FOUNDRY_VERSION}`);
  }
}

/** A fresh local chain that reports Base Sepolia's chain id, so every service runs its testnet config unchanged. */
export async function startAnvil(): Promise<Anvil> {
  assertFoundryVersion();
  const port = await freePort();
  const service = startService("anvil", "anvil", ["--port", String(port), "--chain-id", String(CHAIN_ID), "--host", "127.0.0.1", "--silent"]);
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    "anvil RPC",
    async () => {
      const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      return res.ok;
    },
    { service, timeoutMs: 20_000 },
  );
  return { rpcUrl, service };
}

const runtimeCode = (contract: string, file = contract): Hex =>
  (JSON.parse(readFileSync(join(ROOT, `contracts/out/${file}.sol/${contract}.json`), "utf8")) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;

/**
 * Builds the test contracts and installs their runtime code where Base Sepolia has the real ones:
 * MockUSDC, Multicall3Lite and the ERC-8004 identity/reputation mocks at their canonical addresses.
 * Refuses unless the node identifies as anvil: anvil_setCode and unrestricted mint must never be
 * pointed at a shared network.
 */
export async function installTestContracts(rpcUrl: string) {
  const c = clients(rpcUrl);
  const version = (await c.public.request({ method: "web3_clientVersion" } as never)) as string;
  if (!/^anvil\//i.test(version)) throw new Error(`refusing to install test contracts on a non-anvil node (${version})`);

  execFileSync("forge", ["build", "--root", join(ROOT, "contracts")], { stdio: "pipe" });
  await c.test.setCode({ address: BASE_SEPOLIA_USDC, bytecode: runtimeCode("MockUSDC") });
  await c.test.setCode({ address: MULTICALL3, bytecode: runtimeCode("Multicall3Lite") });
  await c.test.setCode({ address: ERC8004_IDENTITY, bytecode: runtimeCode("MockIdentityRegistry", "MockERC8004") });
  await c.test.setCode({ address: ERC8004_REPUTATION, bytecode: runtimeCode("MockReputationRegistry", "MockERC8004") });

  const [name, v] = await Promise.all([
    c.public.readContract({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, functionName: "name" }),
    c.public.readContract({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, functionName: "version" }),
  ]);
  if (name !== "USDC" || v !== "2") throw new Error(`MockUSDC domain mismatch: ${name}/${v}`);
}

export async function mintUsdc(rpcUrl: string, to: Address, atomic: bigint) {
  const c = clients(rpcUrl);
  const hash = await c.deployer.writeContract({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, functionName: "mint", args: [to, atomic] });
  const r = await c.public.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`mint to ${to} reverted`);
}

export const usdcBalance = (rpcUrl: string, who: Address) =>
  clients(rpcUrl).public.readContract({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, functionName: "balanceOf", args: [who] });

export { httpOk };

export const ERC8004_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function transferFrom(address from, address to, uint256 agentId)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

/** A wallet acting on chain as itself (agent registration needs gas: anvil funds it directly). */
async function walletFor(rpcUrl: string, key: Hex) {
  const c = clients(rpcUrl);
  const account = privateKeyToAccount(key);
  await c.test.setBalance({ address: account.address, value: 10n ** 18n });
  return createWalletClient({ chain: baseSepolia, transport: http(rpcUrl), account }).extend(publicActions);
}

async function send(w: Awaited<ReturnType<typeof walletFor>>, args: Parameters<typeof w.writeContract>[0]) {
  const hash = await w.writeContract(args);
  const r = await w.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${args.functionName} reverted`);
  return r;
}

/** Registers an ERC-8004 agent owned by `key`; its verified wallet starts as that address. */
export async function registerAgent(rpcUrl: string, key: Hex): Promise<bigint> {
  const w = await walletFor(rpcUrl, key);
  const r = await send(w, { address: ERC8004_IDENTITY, abi: ERC8004_ABI, functionName: "register", args: ["https://agents.e2e.test/agent.json"] } as never);
  const log = r.logs.find((l) => l.address.toLowerCase() === ERC8004_IDENTITY.toLowerCase() && l.topics.length === 3);
  return BigInt(log!.topics[1]!);
}

export async function transferAgent(rpcUrl: string, key: Hex, agentId: bigint, to: Address) {
  const w = await walletFor(rpcUrl, key);
  await send(w, { address: ERC8004_IDENTITY, abi: ERC8004_ABI, functionName: "transferFrom", args: [w.account.address, to, agentId] } as never);
}

export async function giveFeedback(rpcUrl: string, key: Hex, agentId: bigint, value: number) {
  const w = await walletFor(rpcUrl, key);
  await send(w, {
    address: ERC8004_REPUTATION,
    abi: ERC8004_ABI,
    functionName: "giveFeedback",
    args: [agentId, BigInt(value), 0, "quality", "", "", "", `0x${"00".repeat(32)}`],
  } as never);
}
