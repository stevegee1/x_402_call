/**
 * Pitch demo agent. Pays the gateway through the policy engine and shows each decision.
 *
 *   GATEWAY_URL=http://localhost:8080 WALLET_PRIVATE_KEY=0x... pnpm demo:agent
 *   ... pnpm demo:agent --runaway     # fires requests until the velocity breaker trips
 *   MX_API_KEY=mk_test_... pnpm demo:agent   # fiat-credits rail instead of a wallet
 *
 * Fund the wallet with Base Sepolia USDC from https://faucet.circle.com (testnet only).
 */
import { createPolicyClient, DEFAULT_BREAKERS, EXPLORER_TX, PolicyDeniedError } from "@mx/policy-sdk";
import { privateKeyToAccount } from "viem/accounts";

const gateway = (process.env.GATEWAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
const network = process.env.NETWORK ?? "eip155:84532";
const runaway = process.argv.includes("--runaway");
const signer = process.env.WALLET_PRIVATE_KEY ? privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`) : undefined;
const apiKey = process.env.MX_API_KEY;
if (!signer && !apiKey) throw new Error("set WALLET_PRIVATE_KEY (x402) or MX_API_KEY (credits)");

const client = createPolicyClient({
  policy: {
    agentId: runaway ? "runaway-agent" : "ops-agent",
    costCentre: "CC-OPS-UK",
    maxPricePerRequestUsd: 0.1,
    dailyBudgetUsd: 1,
    dailyBudgetGbp: 1,
    allowedNetworks: [network],
    allowedOrigins: [new URL(gateway).origin],
    breakers: { ...DEFAULT_BREAKERS, velocity: { maxPayments: 8, windowMs: 60_000 } },
  },
  signer,
  credits: apiKey ? { apiKey, origins: [new URL(gateway).origin] } : undefined,
  report: apiKey ? { url: `${gateway}/v1/policy/events`, apiKey } : undefined,
});

const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", reset: "\x1b[0m" };

async function call(path: string) {
  const t0 = performance.now();
  try {
    const res = await client.fetch(`${gateway}${path}`);
    const body = await res.json();
    const ms = Math.round(performance.now() - t0);
    const id = res.headers.get("x-payment-id");
    const charged = res.headers.get("x-credits-charged-gbp-micros");
    if (!res.ok) {
      const reason = res.status === 402 ? (body.error ?? "payment rejected") : (body.error ?? body.detail);
      console.log(`${c.red}✖ ${res.status}${c.reset} ${path} ${c.dim}${ms}ms · ${reason}${c.reset}`);
      return null;
    }
    const how = charged ? `£${Number(charged) / 1e6} credits` : id ? `x402 payment ${id.slice(0, 8)} (${res.headers.get("x-settlement")})` : "free";
    console.log(`${c.green}✔${c.reset} ${path} ${c.dim}${res.status} ${ms}ms · ${how} · mode=${body.mode ?? "-"} count=${body.count ?? "-"}${c.reset}`);
    return { id, body };
  } catch (e) {
    if (e instanceof PolicyDeniedError) console.log(`${c.red}✖ DENIED${c.reset} ${path} ${c.dim}${e.code}: ${e.message}${c.reset}`);
    else console.log(`${c.red}✖ ERROR${c.reset} ${path} ${(e as Error).message}`);
    return null;
  }
}

if (runaway) {
  console.log(`${c.cyan}Runaway agent: hammering the API until the policy engine stops it${c.reset}`);
  for (let i = 0; i < 30; i++) {
    const r = await call(`/v1/dover/vessels?min_speed_kn=${i % 5}`);
    if (!r) break;
  }
} else {
  console.log(`${c.cyan}Ops agent: Dover Strait situational picture${c.reset}`);
  await call("/v1/regions");
  const v = await call("/v1/dover/vessels?category=tanker");
  await call("/v1/dover/anomalies");
  await call("/v1/dover/queue");
  const first = v?.body?.data?.[0];
  if (first) await call(`/v1/dover/vessels/${first.mmsi}`);
}

// Show settlement results for x402 payments.
await new Promise((r) => setTimeout(r, 4_000));
for (const rec of client.spendLog.all().filter((r) => r.paymentId)) {
  const s = await (await fetch(`${gateway}/v1/payments/${rec.paymentId}`)).json();
  console.log(`  payment ${rec.paymentId!.slice(0, 8)} ${s.status} ${s.transaction ? (EXPLORER_TX[network] ?? "") + s.transaction : ""}`);
}
await client.flush();
console.log(`${c.dim}spent today: $${client.spendLog.spentToday("USD").toFixed(3)} USDC, £${client.spendLog.spentToday("GBP").toFixed(3)} credits · breakers ${JSON.stringify(client.breakers.snapshot())}${c.reset}`);
