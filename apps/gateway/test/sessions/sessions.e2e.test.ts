import { createPolicyClient, DEFAULT_BREAKERS } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNTS } from "../../src/ledger/journal";
import { SessionManager } from "../../src/sessions/manager";
import { AcmeProduct } from "../platform/fake-product";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, SESSION_SECRET, type TestEnv } from "../helpers";

const S = `${BASE_URL}/v1/sessions`;
const READING = `${BASE_URL}/v1/acme/north/reading`; // $0.05
const REPORT = (r: string) => `${BASE_URL}/v1/acme/north/reports/${r}`; // $0.01

describe("x402 sessions end to end (in-process)", () => {
  let env: TestEnv;
  let acme: AcmeProduct;

  beforeEach(async () => {
    acme = new AcmeProduct();
    env = await createTestEnv({}, { products: [acme], sessions: true });
  });
  afterEach(() => vi.useRealTimers());

  const buyer = () =>
    createPolicyClient({
      policy: { agentId: "s", maxPricePerRequestUsd: 25, dailyBudgetUsd: 100, dailyBudgetGbp: 100, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: env.fetch,
    });
  async function buy(size = "usd1") {
    const res = await buyer().fetch(`${S}/${size}`);
    expect(res.status).toBe(201);
    return (await res.json()) as { session_token: string; session_id: string; expires_at: string; amount_usdc: string; payer: string };
  }
  const read = (url: string, token: string) => env.fetch(url, { headers: { authorization: `Session ${token}` } });
  const balances = async () => {
    const b = new Map<string, number>();
    for (const j of await env.store.journal()) for (const l of j.lines) b.set(l.account, (b.get(l.account) ?? 0) + l.credit - l.debit);
    return b;
  };

  it("lists the sizes, shows sessions in the catalog, and advertises them in every 402", async () => {
    const sizes = await (await env.fetch(`${S}/sizes`)).json();
    expect(sizes.data.map((d: { id: string; price_usdc: string }) => [d.id, d.price_usdc])).toEqual([
      ["sessions.usd1", "1"],
      ["sessions.usd5", "5"],
      ["sessions.usd20", "20"],
    ]);
    const products = await (await env.fetch(`${BASE_URL}/v1/products`)).json();
    expect(products.data.map((p: { id: string }) => p.id)).toContain("sessions");
    const challenge = await env.fetch(READING);
    expect(challenge.status).toBe(402);
    expect((await challenge.json()).sessions).toEqual({ sizes: `${S}/sizes`, usage: "Authorization: Session <token>" });
    const buy402 = await env.fetch(`${S}/usd5`);
    expect(decodePaymentRequiredHeader(buy402.headers.get("PAYMENT-REQUIRED")!).accepts[0]!.amount).toBe("5000000");
  });

  it("buying settles on chain before the token is issued, and books a liability, not revenue", async () => {
    const s = await buy("usd5");
    expect(s.session_token).toMatch(/^ses_[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    expect(s.amount_usdc).toBe("5");
    const p = (await env.store.getPayment(s.session_id))!;
    expect(p).toMatchObject({ status: "settled", settleMode: "sync", endpoint: "sessions.usd5" });
    expect(new Date(s.expires_at).getTime()).toBe(p.settledAt!.getTime() + 3_600_000);
    const b = await balances();
    expect(b.get(ACCOUNTS.sessionPrepaid)).toBe(3_333_333); // $5 at 0.8, less 20 % VAT
    expect([...b.keys()].filter((k) => k.startsWith("revenue:"))).toEqual([]);
  });

  it("reads spend the session from memory, with charge and balance headers, then journal revenue on flush", async () => {
    const s = await buy("usd1");
    for (let i = 0; i < 4; i++) {
      const r = await read(READING, s.session_token);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-session-charged-usdc-atomic")).toBe("50000");
      expect(r.headers.get("x-session-remaining-usdc-atomic")).toBe(String(1_000_000 - 50_000 * (i + 1)));
    }
    expect((await read(REPORT("q3"), s.session_token)).status).toBe(200);
    await env.deps.sessions!.flush();
    const sess = (await env.store.getSession(s.session_id))!;
    expect(sess.spentAtomic).toBe(210_000n);
    const b = await balances();
    // floor(666 667 × 210 000 / 1 000 000) = 140 000 released to revenue:acme.
    expect(b.get("revenue:acme")).toBe(140_000);
    expect(b.get(ACCOUNTS.sessionPrepaid)).toBe(666_667 - 140_000);
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(1); // the purchase only: reads are not x402 payments
  });

  it("refuses with 402 session_exhausted once the balance can't cover the price", async () => {
    const s = await buy("usd1");
    for (let i = 0; i < 20; i++) expect((await read(READING, s.session_token)).status).toBe(200); // $1.00 exactly
    const r = await read(READING, s.session_token);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("session_exhausted");
    await env.deps.sessions!.flush();
    expect((await env.store.getSession(s.session_id))!.spentAtomic).toBe(1_000_000n);
  });

  it("refunds a charge whose handler fails, and never charges a request refused before billing", async () => {
    const s = await buy("usd1");
    acme.handlerStatus = 502;
    const failed = await read(READING, s.session_token);
    expect(failed.status).toBe(502);
    expect(failed.headers.get("x-session-charged-usdc-atomic")).toBe("0");
    expect((await read(REPORT("missing"), s.session_token)).status).toBe(404); // precheck: before any charge
    acme.fresh = false;
    expect((await read(READING, s.session_token)).status).toBe(503); // stale: before any charge
    await env.deps.sessions!.flush();
    expect((await env.store.getSession(s.session_id))!.spentAtomic).toBe(0n);
    expect(env.deps.sessions!.remaining(s.session_id)).toBe(1_000_000n);
  });

  it("rejects forged, tampered and non-session tokens", async () => {
    const s = await buy("usd1");
    const [head, mac] = s.session_token.split(".");
    expect((await read(READING, `${head}.${mac!.slice(0, -2)}AA`)).status).toBe(401);
    expect((await read(READING, "ses_nope")).status).toBe(401);
    // A genuine-looking token for a payment that isn't a session purchase.
    await (await buyer().fetch(READING)).arrayBuffer();
    const dataPayment = (await env.store.listPayments({ limit: 10 })).find((p) => p.endpoint === "acme.reading")!;
    await env.deps.settler.tick(new Date(Date.now() + 10_000));
    const wrong = env.deps.sessions!.tokens.issue(dataPayment.id);
    const r = await read(READING, wrong);
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("invalid_session");
    // A token signed with another secret.
    const other = new SessionManager(env.store, { secret: `${SESSION_SECRET}-other`, ttlMs: 1, leaseAtomic: 1n, flushMs: 1, graceMs: 1 }, env.deps.log, env.deps.metrics);
    expect((await read(READING, other.tokens.issue(s.session_id))).status).toBe(401);
  });

  it("only x402 can buy a session: credits and sessions are refused without charge", async () => {
    const signup = await (await env.fetch(`${BASE_URL}/v1/credits/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "Q Ltd", email: "q@b.test", country: "GB" }) })).json();
    await env.fetch(`${BASE_URL}/admin/credits/${signup.account_id}/topup`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ net_gbp: 10, reference: "t" }) });
    const viaCredits = await env.fetch(`${S}/usd1`, { headers: { authorization: `Bearer ${signup.api_key}` } });
    expect(viaCredits.status).toBe(400);
    expect(await viaCredits.json()).toMatchObject({ error: "rail_not_accepted", accepted: ["x402"] });
    expect((await (await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${signup.api_key}` } })).json()).balance_gbp).toBe(10);
    const s = await buy("usd1");
    expect((await read(`${S}/usd1`, s.session_token)).status).toBe(400);
  });

  it("expires after the TTL, and the sweeper books the unused balance as breakage", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    const s = await buy("usd1");
    expect((await read(READING, s.session_token)).status).toBe(200);
    vi.setSystemTime(new Date(s.expires_at).getTime() + 1);
    const r = await read(READING, s.session_token);
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("session_expired");
    await env.deps.sessions!.flush(); // reports the one read and hands the rest of the lease back
    vi.setSystemTime(new Date(s.expires_at).getTime() + 120_001);
    expect(await env.deps.sessions!.sweep()).toBe(1);
    const b = await balances();
    expect(b.get(ACCOUNTS.sessionPrepaid)).toBe(0);
    expect(b.get("revenue:acme")).toBe(33_333); // floor(666 667 × 0.05)
    expect(b.get(ACCOUNTS.sessionBreakage)).toBe(666_667 - 33_333);
  });

  it("two replicas sharing one session can never spend more than was paid", async () => {
    const s = await buy("usd1");
    const opts = { secret: SESSION_SECRET, ttlMs: 3_600_000, leaseAtomic: 100_000n, flushMs: 1_000, graceMs: 120_000 };
    const a = new SessionManager(env.store, opts, env.deps.log, env.deps.metrics);
    const b = new SessionManager(env.store, opts, env.deps.log, env.deps.metrics);
    let charged = 0n;
    for (let round = 0; round < 40; round++) {
      const results = await Promise.all([a, b, a, b].map((m) => m.charge(s.session_token, "acme.report", 10_000n)));
      for (const r of results) if (r.ok) charged += r.ticket.priceAtomic;
    }
    expect(charged).toBe(1_000_000n); // every cent, and not one more
    await a.stop();
    await b.stop();
    const sess = (await env.store.getSession(s.session_id))!;
    expect(sess).toMatchObject({ spentAtomic: 1_000_000n, reservedAtomic: 1_000_000n });
  });

  it("stop() reports spend and hands the unspent lease back for other replicas", async () => {
    const s = await buy("usd1");
    expect((await read(REPORT("a"), s.session_token)).status).toBe(200);
    expect((await env.store.getSession(s.session_id))!.reservedAtomic).toBe(250_000n);
    await env.deps.sessions!.stop();
    expect(await env.store.getSession(s.session_id)).toMatchObject({ spentAtomic: 10_000n, reservedAtomic: 10_000n });
  });
});
