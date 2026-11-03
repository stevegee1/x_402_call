import { createPolicyClient, DEFAULT_BREAKERS, PolicyDeniedError, type Policy } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../src/ledger/journal";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, PAY_TO, type TestEnv } from "./helpers";

const policy = (over: Partial<Policy> = {}): Policy => ({
  agentId: "test-agent",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  dailyBudgetGbp: 5,
  allowedNetworks: ["eip155:84532"],
  allowedOrigins: [BASE_URL],
  breakers: DEFAULT_BREAKERS,
  ...over,
});

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function settleAll(env: TestEnv) {
  await env.deps.settler.tick(new Date(Date.now() + 10_000));
}

describe("public endpoints", () => {
  it("lists regions with prices for both rails", async () => {
    const env = await createTestEnv();
    const res = await env.fetch(`${BASE_URL}/v1/maritime/regions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: { id: string }) => r.id)).toEqual(["dover", "rotterdam", "panama"]);
    expect(body.data[0].endpoints[0]).toMatchObject({ price_usdc: "0.033", price_credits_gbp: 0.025 });
  });

  it("unknown region is a free 404", async () => {
    const env = await createTestEnv();
    expect((await env.fetch(`${BASE_URL}/v1/maritime/atlantis/vessels`)).status).toBe(404);
  });
});

describe("x402 rail", () => {
  let env: TestEnv;
  const account = privateKeyToAccount(generatePrivateKey());
  beforeEach(async () => {
    env = await createTestEnv();
  });

  it("challenges with a v2 PAYMENT-REQUIRED header and a credits alternative", async () => {
    const res = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "33000", payTo: PAY_TO });
    expect(pr.resource.url).toBe(`${BASE_URL}/v1/maritime/dover/vessels`);
    const body = await res.json();
    expect(body.credits.price_gbp).toBe(0.025);
  });

  it("pays via the policy SDK, serves data, settles async and books VAT-inclusive revenue", async () => {
    const client = createPolicyClient({ policy: policy(), signer: account, fetch: env.fetch });
    const res = await client.fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Settlement")).toBe("pending");
    const body = await res.json();
    expect(body).toMatchObject({ region: "dover", mode: "simulated", degraded: false });
    expect(body.data.length).toBeGreaterThan(0);

    const id = res.headers.get("X-Payment-Id")!;
    expect((await env.store.getPayment(id))?.status).toBe("verified");
    expect((await env.store.exposure()).totalAtomic).toBe(33_000n);

    await settleAll(env);
    const p = await env.store.getPayment(id);
    expect(p?.status).toBe("settled");
    expect(p?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await env.store.exposure()).totalAtomic).toBe(0n);

    const journal = await env.store.journal();
    expect(journal).toHaveLength(1);
    // 0.033 USD * 0.8 = £0.0264 gross; VAT = 1/6 of gross.
    expect(journal[0]!.lines).toEqual([
      { account: "asset:usdc_wallet", debit: 26_400, credit: 0 },
      { account: "revenue:maritime", debit: 0, credit: 22_000 },
      { account: "liability:vat_output", debit: 0, credit: 4_400 },
    ]);
    expect(verifyChain(journal)).toEqual({ ok: true });
    expect(client.spendLog.spentToday("USD")).toBeCloseTo(0.033);

    const status = await (await env.fetch(`${BASE_URL}/v1/payments/${id}`)).json();
    expect(status).toMatchObject({ status: "settled", amount_usdc: 0.033 });

    // Operator view carries what on-chain reconciliation keys on: (payer, nonce) and the exact atomic amount.
    const admin = await (await env.fetch(`${BASE_URL}/admin/payments?status=settled`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
    expect(admin.data).toEqual([
      expect.objectContaining({ id, payer: account.address.toLowerCase(), network: "eip155:84532", nonce: p!.nonce, amount_atomic: "33000", tx: p!.txHash }),
    ]);
  });

  it("rejects a replayed payment signature", async () => {
    const seen: Request[] = [];
    const spy = ((i: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(i, init);
      seen.push(r.clone());
      return env.fetch(r);
    }) as typeof fetch;
    const client = createPolicyClient({ policy: policy(), signer: account, fetch: spy });
    expect((await client.fetch(`${BASE_URL}/v1/maritime/dover/density`)).status).toBe(200);
    const paid = seen.find((r) => r.headers.has("PAYMENT-SIGNATURE"))!;
    const replay = await env.fetch(`${BASE_URL}/v1/maritime/dover/density`, { headers: { "PAYMENT-SIGNATURE": paid.headers.get("PAYMENT-SIGNATURE")! } });
    expect(replay.status).toBe(402);
    expect(decodePaymentRequiredHeader(replay.headers.get("PAYMENT-REQUIRED")!).error).toBe("payment_already_used");
  });

  it("settles synchronously when the exposure cap would be exceeded", async () => {
    env = await createTestEnv({ EXPOSURE_CAP_PER_PAYER_USD: "0.01" });
    const client = createPolicyClient({ policy: policy(), signer: account, fetch: env.fetch });
    const res = await client.fetch(`${BASE_URL}/v1/maritime/dover/queue`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Settlement")).toBe("settled");
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settle.success).toBe(true);
    expect(env.facilitator.settled).toContain(settle.transaction);
    expect((await env.store.exposure()).totalAtomic).toBe(0n);
  });

  it("refuses tampered payments", async () => {
    const seen: Request[] = [];
    const spy = ((i: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(i, init);
      seen.push(r.clone());
      return env.fetch(r);
    }) as typeof fetch;
    // Sign for density, then try to use a modified payload (value lowered) elsewhere.
    await createPolicyClient({ policy: policy(), signer: account, fetch: spy }).fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    const header = seen.find((r) => r.headers.has("PAYMENT-SIGNATURE"))!.headers.get("PAYMENT-SIGNATURE")!;
    const payload = JSON.parse(Buffer.from(header, "base64").toString());
    payload.payload.authorization.nonce = `0x${"ab".repeat(32)}`;
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64");
    const res = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`, { headers: { "PAYMENT-SIGNATURE": forged } });
    expect(res.status).toBe(402);
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error).toContain("signature");
  });

  it("does not charge when the facilitator is down (503 + breaker)", async () => {
    env.facilitator.down = true;
    // The SDK's own pay-and-fail breaker would (correctly) block the seller after 3 failures;
    // raise it here so we observe the gateway-side breaker.
    const client = createPolicyClient({ policy: policy({ breakers: { ...DEFAULT_BREAKERS, payAndFailThreshold: 100 } }), signer: account, fetch: env.fetch });
    for (let i = 0; i < 4; i++) {
      const res = await client.fetch(`${BASE_URL}/v1/maritime/dover/vessels?min_speed_kn=${i}`);
      expect(res.status).toBe(503);
    }
    expect(env.deps.facilitator.breaker.state).toBe("open");
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(0);
  });

  it("refuses sanctioned payers", async () => {
    (env.deps.sanctions as unknown as { addToDenylist(a: string): void }).addToDenylist(account.address);
    const res = await createPolicyClient({ policy: policy(), signer: account, fetch: env.fetch }).fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(403);
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(0);
  });

  it("never charges for stale data", async () => {
    env.world.regions.get("dover")!.lastMessageAt = Date.now() - 10 * 60_000;
    env.engine.buildAll();
    const res = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("data_stale");
  });

  it("never sells simulated data on mainnet", async () => {
    env = await createTestEnv({ X402_NETWORK: "eip155:8453" });
    const res = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("not_for_sale");
  });

  it("does not charge for a vessel that is not in the snapshot", async () => {
    const client = createPolicyClient({ policy: policy(), signer: account, fetch: env.fetch });
    const res = await client.fetch(`${BASE_URL}/v1/maritime/dover/vessels/999999999`);
    expect(res.status).toBe(404);
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(0);
    expect(client.spendLog.spentToday("USD")).toBe(0);
  });
});

describe("policy engine (buyer side)", () => {
  it("denies payments above the policy max before signing", async () => {
    const env = await createTestEnv();
    const client = createPolicyClient({ policy: policy({ maxPricePerRequestUsd: 0.05 }), signer: privateKeyToAccount(generatePrivateKey()), fetch: env.fetch });
    await expect(client.fetch(`${BASE_URL}/v1/maritime/dover/anomalies`)).rejects.toMatchObject({ code: "price_above_max" });
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(0);
  });

  it("trips the velocity breaker on a runaway agent", async () => {
    const env = await createTestEnv();
    const client = createPolicyClient({
      policy: policy({ breakers: { ...DEFAULT_BREAKERS, velocity: { maxPayments: 5, windowMs: 60_000 } } }),
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: env.fetch,
    });
    let paid = 0;
    let denied: PolicyDeniedError | undefined;
    for (let i = 0; i < 20 && !denied; i++) {
      try {
        if ((await client.fetch(`${BASE_URL}/v1/maritime/dover/vessels?min_speed_kn=${i}`)).ok) paid++;
      } catch (e) {
        denied = e as PolicyDeniedError;
      }
    }
    expect(paid).toBe(5);
    expect(denied?.code).toBe("velocity_breaker_open");
    expect(client.breakers.snapshot().velocityOpenUntil).not.toBeNull();
  });
});

describe("fiat credits rail", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await createTestEnv();
  });

  async function signup(country = "GB", vat?: string) {
    const res = await env.fetch(`${BASE_URL}/v1/credits/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "Acme Shipping Ltd", email: "ops@acme.example", country, vat_number: vat }),
    });
    return { status: res.status, body: await res.json() };
  }

  it("requires a tax id for non-UK accounts", async () => {
    expect((await signup("NL")).status).toBe(400);
    expect((await signup("NL", "NL123456789B01")).status).toBe(201);
  });

  it("charges credits per request with VAT recognised at top-up", async () => {
    const { body } = await signup();
    const key = body.api_key as string;
    expect(key).toMatch(/^mk_test_/);

    // No balance yet: 402 with both rails advertised.
    const empty = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`, { headers: { authorization: `Bearer ${key}` } });
    expect(empty.status).toBe(402);
    expect((await empty.json()).credits_balance_gbp).toBe(0);

    // Bank-transfer top-up by ops (enterprise path).
    const top = await env.fetch(`${BASE_URL}/admin/credits/${body.account_id}/topup`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ net_gbp: 20, reference: "INV-0001" }),
    });
    expect((await top.json()).result).toBe("applied");
    // Same reference again is idempotent.
    const again = await env.fetch(`${BASE_URL}/admin/credits/${body.account_id}/topup`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ net_gbp: 20, reference: "INV-0001" }),
    });
    expect((await again.json()).result).toBe("duplicate");

    const client = createPolicyClient({ policy: policy(), credits: { apiKey: key, origins: [BASE_URL] }, fetch: env.fetch });
    const res = await client.fetch(`${BASE_URL}/v1/maritime/dover/queue`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Credits-Charged-Gbp-Micros")).toBe("50000");
    expect(res.headers.get("X-Credits-Balance-Gbp-Micros")).toBe(String(20_000_000 - 50_000));
    expect(client.spendLog.spentToday("GBP")).toBeCloseTo(0.05);

    // 404 on a missing vessel is not charged.
    const miss = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels/1`, { headers: { authorization: `Bearer ${key}` } });
    expect(miss.status).toBe(404);
    const bal = await (await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(bal.balance_gbp).toBeCloseTo(19.95);

    const vat = await (await env.fetch(`${BASE_URL}/admin/vat-summary`, { headers: admin })).json();
    expect(vat.box1_vat_due_on_sales_gbp).toBe(4); // 20% of £20 at top-up
    expect(vat.box6_total_sales_ex_vat_gbp).toBe(20);
    expect((await (await env.fetch(`${BASE_URL}/admin/ledger/verify`, { headers: admin })).json()).ok).toBe(true);
  });

  it("applies Stripe top-ups idempotently from the webhook", async () => {
    const { body } = await signup();
    const key = body.api_key as string;
    const co = await env.fetch(`${BASE_URL}/v1/credits/checkout`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ pack: "team" }),
    });
    expect((await co.json()).checkout_url).toContain("checkout.stripe.test");
    expect(env.checkout.created[0]).toMatchObject({ netMicros: 100_000_000, vatMicros: 20_000_000, vatTreatment: "uk_standard" });

    env.checkout.next = { type: "topup_paid", sessionId: "cs_test_1", accountId: body.account_id, packId: "team", netMicros: 100_000_000, vatMicros: 20_000_000, vatTreatment: "uk_standard" };
    const hook = () => env.fetch(`${BASE_URL}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "valid" }, body: "{}" });
    expect((await (await hook()).json()).applied).toBe(true);
    expect((await (await hook()).json()).applied).toBe(false);
    expect((await env.fetch(`${BASE_URL}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "forged" }, body: "{}" })).status).toBe(400);

    const bal = await (await env.fetch(`${BASE_URL}/v1/credits/balance`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(bal.balance_gbp).toBe(100);
  });

  it("rejects malformed and unknown API keys", async () => {
    expect((await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`, { headers: { authorization: "Bearer mk_test_short" } })).status).toBe(401);
    expect((await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`, { headers: { authorization: `Bearer mk_test_${"a".repeat(32)}` } })).status).toBe(401);
  });
});

describe("admin", () => {
  it("requires the admin token", async () => {
    const env = await createTestEnv();
    expect((await env.fetch(`${BASE_URL}/admin/summary`)).status).toBe(401);
    expect((await env.fetch(`${BASE_URL}/admin/summary`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await env.fetch(`${BASE_URL}/admin/summary`, { headers: admin })).status).toBe(200);
  });

  it("exports an HMRC-ready ledger CSV with crypto valuation evidence", async () => {
    const env = await createTestEnv();
    const client = createPolicyClient({ policy: policy(), signer: privateKeyToAccount(generatePrivateKey()), fetch: env.fetch });
    await client.fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    await settleAll(env);
    const csv = await (await env.fetch(`${BASE_URL}/admin/ledger.csv`, { headers: admin })).text();
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("fx_usdc_gbp");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("uk_standard_inclusive");
    expect(lines[1]).toContain(",0.033,0.8,fixed,0x");
  });

  it("feeds the Panama draught limit into the queue product", async () => {
    const env = await createTestEnv();
    const put = await env.fetch(`${BASE_URL}/admin/maritime/conditions/panama-draught`, {
      method: "PUT",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ value_m: 13.4, source: "ACP Advisory to Shipping A-XX-2026" }),
    });
    expect(put.status).toBe(200);
    env.engine.buildAll();
    const q = JSON.parse(env.engine.get("panama").bodies.queue);
    expect(q.data.draught_limit).toMatchObject({ value_m: 13.4, source: "ACP Advisory to Shipping A-XX-2026" });
  });
});
