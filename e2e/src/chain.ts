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
export const CHAIN_ID = 84532;

/** anvil's well-known dev keys (public; local chain only). #0 mints, #1 is the facilitator's gas wallet. */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  facilitator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
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

const runtimeCode = (contract: string): Hex =>
  (JSON.parse(readFileSync(join(ROOT, `contracts/out/${contract}.sol/${contract}.json`), "utf8")) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;

/**
 * Builds the test contracts and installs their runtime code where Base Sepolia has the real ones:
 * MockUSDC at the canonical USDC address and Multicall3Lite at the canonical Multicall3 address.
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
