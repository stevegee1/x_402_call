/**
 * Production smoke check (run hourly from CI): free endpoints up, data fresh, 402 challenge
 * well-formed. Exits non-zero on failure so the workflow alerts.
 *
 *   GATEWAY_URL=https://api.example.com pnpm smoke
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";

const gateway = (process.env.GATEWAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};

const health = await fetch(`${gateway}/readyz`);
check(health.ok, `readyz ${health.status}`);

const status = await (await fetch(`${gateway}/status`)).json();
for (const r of status.regions as { id: string; status: string; stale: boolean; data_age_s: number | null }[]) {
  if (r.status === "live") check(!r.stale, `${r.id} fresh (data age ${r.data_age_s}s)`);
}

const challenge = await fetch(`${gateway}/v1/dover/vessels`);
check(challenge.status === 402 || challenge.status === 503, `paid endpoint challenges (${challenge.status})`);
if (challenge.status === 402) {
  const pr = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED") ?? "");
  check(pr.x402Version === 2 && pr.accepts.length > 0 && pr.accepts[0]!.amount === "33000", "PAYMENT-REQUIRED header valid");
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
