/**
 * What one x402 settle costs the facilitator in gas, measured from real settles.
 *
 * Takes the USDC settles that paid PAY_TO on Base Sepolia (their gas use is the same contract call
 * we pay for on mainnet), then reprices each one at Base mainnet's current fees and Chainlink ETH/USD: L2 execution
 * (gasUsed x gas price) plus the L1 data fee from the GasPriceOracle predeploy, for the same raw
 * transaction bytes. Read-only; no keys.
 *
 *   pnpm gas:cost                       # staging PAY_TO, last 50 settles
 *   PAY_TO=0x... SAMPLE=100 pnpm gas:cost
 */
import { createPublicClient, http, parseAbi, keccak256, serializeTransaction, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

const PAY_TO = (process.env.PAY_TO ?? "0x35E13c683A70fBe048CDB897cE1bAe36440fcd19").toLowerCase();
const SAMPLE = Number(process.env.SAMPLE ?? 50);
const BLOCKSCOUT = process.env.BLOCKSCOUT_URL ?? "https://base-sepolia.blockscout.com";

/** USDC transferWithAuthorization selectors: (v,r,s) form and (bytes signature) form. */
const SETTLE_SELECTORS = new Set(["0xe3ee160e", "0xcf092995"]);
const ORACLE = "0x420000000000000000000000000000000000000F" as const;
const oracleAbi = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
/** Chainlink ETH/USD on Base mainnet (8 decimals). */
const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const;
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

const sepolia = createPublicClient({ chain: baseSepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
const mainnet = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });

async function settleHashes(): Promise<Hex[]> {
  const hashes = new Set<Hex>();
  let params = "";
  while (hashes.size < SAMPLE) {
    const r = await fetch(`${BLOCKSCOUT}/api/v2/addresses/${PAY_TO}/token-transfers?type=ERC-20&filter=to${params}`);
    if (!r.ok) throw new Error(`blockscout ${r.status}`);
    const d = (await r.json()) as { items: { transaction_hash: Hex }[]; next_page_params: Record<string, string> | null };
    for (const i of d.items) hashes.add(i.transaction_hash);
    if (!d.next_page_params) break;
    params = "&" + new URLSearchParams(d.next_page_params).toString();
  }
  return [...hashes].slice(0, SAMPLE);
}

/** The signed transaction's bytes, rebuilt from its fields (public RPCs often refuse eth_getRawTransactionByHash). */
function signedBytes(tx: Awaited<ReturnType<typeof sepolia.getTransaction>>): Hex {
  if (tx.type !== "eip1559") throw new Error(`unexpected tx type ${tx.type} for ${tx.hash}`);
  return serializeTransaction(
    { type: "eip1559", chainId: tx.chainId, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, to: tx.to!, value: tx.value, data: tx.input, accessList: tx.accessList },
    { r: tx.r, s: tx.s, yParity: tx.yParity },
  );
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

const ethUsd = Number((await mainnet.readContract({ address: ETH_USD_FEED, abi: feedAbi, functionName: "latestRoundData" }))[1]) / 1e8;
const gasPrice = await mainnet.getGasPrice();

const rows: { hash: Hex; gasUsed: bigint; l2Wei: bigint; l1Wei: bigint; usd: number }[] = [];
for (const hash of await settleHashes()) {
  const [tx, receipt] = await Promise.all([sepolia.getTransaction({ hash }), sepolia.getTransactionReceipt({ hash })]);
  if (!SETTLE_SELECTORS.has(tx.input.slice(0, 10)) || receipt.status !== "success") continue;
  const raw = signedBytes(tx);
  if (keccak256(raw) !== hash) throw new Error(`rebuilt bytes do not hash to ${hash}`);
  const l1Wei = await mainnet.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getL1Fee", args: [raw] });
  const l2Wei = receipt.gasUsed * gasPrice;
  rows.push({ hash, gasUsed: receipt.gasUsed, l2Wei, l1Wei, usd: (Number(l2Wei + l1Wei) / 1e18) * ethUsd });
}
if (!rows.length) throw new Error("no settle transactions found");

const usd = rows.map((r) => r.usd).sort((a, b) => a - b);
const gas = rows.map((r) => Number(r.gasUsed)).sort((a, b) => a - b);
const l1Share = rows.reduce((s, r) => s + Number(r.l1Wei), 0) / rows.reduce((s, r) => s + Number(r.l1Wei + r.l2Wei), 0);
console.log(JSON.stringify({
  settles: rows.length,
  base_mainnet_gas_price_gwei: Number(gasPrice) / 1e9,
  eth_usd: ethUsd,
  gas_used: { p50: pct(gas, 50), p95: pct(gas, 95), max: gas.at(-1) },
  cost_usd: { p50: pct(usd, 50), p95: pct(usd, 95), max: usd.at(-1) },
  l1_fee_share: Number(l1Share.toFixed(3)),
}, null, 2));
