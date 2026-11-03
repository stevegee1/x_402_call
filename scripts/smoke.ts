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

type Scope = { scope: string; status?: string; fresh: boolean; data_age_s?: number | null };
const status = await (await fetch(`${gateway}/status`)).json();
for (const p of status.products as { id: string; ready: boolean; scopes: Scope[] }[]) {
  check(p.ready, `${p.id} ready`);
  // Scopes a product marks as live in production must be fresh; others may be dark.
  for (const s of p.scopes) if (s.status === "live") check(s.fresh, `${p.id}/${s.scope} fresh (data age ${s.data_age_s ?? "?"}s)`);
}

const challenge = await fetch(`${gateway}/v1/maritime/dover/vessels`);
check(challenge.status === 402 || challenge.status === 503, `paid endpoint challenges (${challenge.status})`);
if (challenge.status === 402) {
  const pr = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED") ?? "");
  check(pr.x402Version === 2 && pr.accepts.length > 0 && pr.accepts[0]!.amount === "33000", "PAYMENT-REQUIRED header valid");
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
