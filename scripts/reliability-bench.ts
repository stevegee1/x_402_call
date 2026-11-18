/**
 * Reliability benchmark against a live gateway: success rate and latency per payment rail.
 *
 *   GATEWAY_URL=https://mxgateway-staging.up.railway.app \
 *   WALLET_PRIVATE_KEY=0x... MX_API_KEY=mk_test_... pnpm tsx scripts/reliability-bench.ts
 *
 * Spends real (test) money: about $1.30 USDC and £0.16 of credits per run with the defaults.
 * N_SEQ, N_BURST, N_SESSION, N_CREDITS override the counts.
 */
import { createPolicyClient } from "@mx/policy-sdk";
import { privateKeyToAccount } from "viem/accounts";

const gateway = (process.env.GATEWAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
const network = process.env.NETWORK ?? "eip155:84532";
const n = (k: string, d: number) => Number(process.env[k] ?? d);
const N_SEQ = n("N_SEQ", 20), N_BURST = n("N_BURST", 10), N_SESSION = n("N_SESSION", 50), N_CREDITS = n("N_CREDITS", 20);
const PATH = "/v1/grid/england/intensity";

const loose = { maxPayments: 10_000, windowMs: 60_000 };
const policy = {
  agentId: "reliability-bench",
  maxPricePerRequestUsd: 1.01,
  dailyBudgetUsd: 5,
  dailyBudgetGbp: 1,
  allowedNetworks: [network],
  allowedOrigins: [new URL(gateway).origin],
  breakers: { velocity: loose, perUrl: loose, payAndFailThreshold: 1_000, priceIncreaseTolerance: 10, cooldownMs: 0 },
};
const signer = process.env.WALLET_PRIVATE_KEY ? privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`) : undefined;
const apiKey = process.env.MX_API_KEY;

type Result = { ok: boolean; ms: number; status: number | string };
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : NaN);

function report(name: string, rs: Result[]) {
  const ok = rs.filter((r) => r.ok);
  const ms = ok.map((r) => r.ms);
  const fails = rs.filter((r) => !r.ok).map((r) => r.status);
  console.log(
    `${name.padEnd(34)} ${String(ok.length).padStart(3)}/${String(rs.length).padEnd(3)} ok (${((ok.length / rs.length) * 100).toFixed(1)}%)` +
      `  p50 ${pct(ms, 50)}ms  p95 ${pct(ms, 95)}ms  max ${Math.max(...ms)}ms` +
      (fails.length ? `  failures: ${fails.join(", ")}` : ""),
  );
  return { name, total: rs.length, ok: ok.length, p50: pct(ms, 50), p95: pct(ms, 95) };
}

async function timed(f: () => Promise<Response>): Promise<Result> {
  const t0 = performance.now();
  try {
    const r = await f();
    await r.arrayBuffer();
    return { ok: r.ok, ms: Math.round(performance.now() - t0), status: r.status };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), status: (e as Error).message.slice(0, 60) };
  }
}

async function main() {
  console.log(`gateway ${gateway} · ${new Date().toISOString()}\n`);
  const out = [];

  if (signer) {
    const x402 = createPolicyClient({ policy, signer });
    const seq: Result[] = [];
    for (let i = 0; i < N_SEQ; i++) seq.push(await timed(() => x402.fetch(gateway + PATH)));
    out.push(report(`x402 per call, sequential`, seq));

    const burst = await Promise.all(Array.from({ length: N_BURST }, () => timed(() => x402.fetch(gateway + PATH))));
    out.push(report(`x402 per call, ${N_BURST} concurrent`, burst));

  }

  // Session reads need a token; buy one directly so the token can be read from the body.
  if (signer) {
    const x402 = createPolicyClient({ policy, signer });
    const t0 = performance.now();
    const r = await x402.fetch(`${gateway}/v1/sessions/usd1`);
    out.push(report("x402 session purchase ($1)", [{ ok: r.ok, ms: Math.round(performance.now() - t0), status: r.status }]));
    const body = (await r.json().catch(() => ({}))) as { session_token?: string };
    if (body.session_token) {
      const reads: Result[] = [];
      for (let i = 0; i < N_SESSION; i++) reads.push(await timed(() => fetch(gateway + PATH, { headers: { authorization: `Session ${body.session_token}` } })));
      out.push(report(`session reads, sequential`, reads));
    } else console.log(`session purchase for reads failed: ${r.status}`);
  }

  if (apiKey) {
    const credits: Result[] = [];
    for (let i = 0; i < N_CREDITS; i++) credits.push(await timed(() => fetch(gateway + PATH, { headers: { authorization: `Bearer ${apiKey}` } })));
    out.push(report("credits (card top-up), sequential", credits));
  }

  // ERC-8004: an id the payer doesn't own must fall back to "unknown" and still be served.
  if (signer) {
    const x402 = createPolicyClient({ policy: { ...policy, agentId: "1" }, signer });
    const r = await x402.fetch(gateway + PATH, { headers: { "x-agent-id": "1" } });
    console.log(`ERC-8004 someone else's agent id    → HTTP ${r.status}, tier ${r.headers.get("x-agent-tier")} (expected 200, unknown)`);
  }

  console.log(`\n${JSON.stringify(out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
