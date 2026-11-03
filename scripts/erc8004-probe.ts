/**
 * Read-only check of our ERC-8004 client against the live registries: confirms the canonical
 * addresses, the ABI we call, and getSummary's semantics match what the e2e mocks reproduce.
 *
 *   pnpm erc8004:probe                          # Base Sepolia, public RPC
 *   RPC_URL=... NETWORK=eip155:8453 AGENT_ID=... pnpm erc8004:probe
 */
import { createPublicClient, http, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createAgentRegistry } from "../apps/gateway/src/identity/erc8004";
import { ERC8004_REGISTRIES } from "../apps/gateway/src/identity/registries";

const network = process.env.NETWORK ?? "eip155:84532";
const rpc = process.env.RPC_URL ?? (network === "eip155:8453" ? "https://mainnet.base.org" : "https://sepolia.base.org");
const registries = ERC8004_REGISTRIES[network];
if (!registries) throw new Error(`no canonical registries for ${network}`);
const client = createPublicClient({ chain: network === "eip155:8453" ? base : baseSepolia, transport: http(rpc) });
const agentId = BigInt(process.env.AGENT_ID ?? "1");

const extra = parseAbi(["function name() view returns (string)", "function ownerOf(uint256) view returns (address)", "function getClients(uint256) view returns (address[])", "function getIdentityRegistry() view returns (address)"]);
const fail = (m: string) => {
  console.error(`FAIL ${m}`);
  process.exitCode = 1;
};

const chainId = await client.getChainId();
console.log(`network ${network} (chain ${chainId}) via ${rpc}`);
for (const [k, a] of Object.entries(registries)) {
  const code = await client.getCode({ address: a });
  code && code.length > 2 ? console.log(`ok   ${k} registry has code at ${a}`) : fail(`${k} registry has no code at ${a}`);
}
const linked = await client.readContract({ address: registries.reputation, abi: extra, functionName: "getIdentityRegistry" });
linked.toLowerCase() === registries.identity.toLowerCase() ? console.log("ok   reputation registry points at our identity registry") : fail(`reputation -> ${linked}`);
console.log(`     identity name(): ${await client.readContract({ address: registries.identity, abi: extra, functionName: "name" })}`);

const registry = createAgentRegistry(client, registries);
const wallet = await registry.agentWallet(agentId);
const owner = await client.readContract({ address: registries.identity, abi: extra, functionName: "ownerOf", args: [agentId] }).catch(() => null);
console.log(`ok   agent ${agentId}: owner ${owner ?? "(none)"}, verified wallet ${wallet}`);
const reviewers = await client.readContract({ address: registries.reputation, abi: extra, functionName: "getClients", args: [agentId] });
if (reviewers.length) {
  const summary = await registry.reputation(agentId, reviewers.slice(0, 20), "");
  console.log(`ok   reputation over ${Math.min(reviewers.length, 20)} reviewer(s): count ${summary.count}, mean ${summary.score}`);
} else console.log("     no feedback on this agent");
