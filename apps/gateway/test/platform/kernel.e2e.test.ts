import { createPolicyClient, DEFAULT_BREAKERS, type Policy } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../../src/ledger/journal";
import { ADMIN_TOKEN, BASE_URL, createTestEnv, PAY_TO, type TestEnv } from "../helpers";
import { AcmeProduct } from "./fake-product";

/**
 * Kernel invariants, proven against a product that is not maritime. If one of these fails, a new
 * product could charge for stale data, sell simulated data on mainnet, or charge for failures.
 */

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
const READING = `${BASE_URL}/v1/acme/north/reading`;

const policy = (over: Partial<Policy> = {}): Policy => ({
  agentId: "kernel-test",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  dailyBudgetGbp: 5,
  allowedNetworks: ["eip155:84532"],
  allowedOrigins: [BASE_URL],
  breakers: DEFAULT_BREAKERS,
  ...over,
});

async function setup(cfg: Record<string, string> = {}) {
  const acme = new AcmeProduct();
  const env = await createTestEnv(cfg, { products: [acme] });
  return { env, acme };
}

async function fundedKey(env: TestEnv, netGbp = 10): Promise<{ key: string; accountId: string }> {
  const res = await env.fetch(`${BASE_URL}/v1/credits/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ company: "Kernel Test Ltd", email: "ops@kernel.example", country: "GB" }),
  });
  const body = await res.json();
  await env.fetch(`${BASE_URL}/admin/credits/${body.account_id}/topup`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ net_gbp: netGbp, reference: `INV-${body.account_id}` }),
  });
  return { key: body.api_key, accountId: body.account_id };
}

const balance = async (env: TestEnv, accountId: string) => (await env.store.getAccount(accountId))!.balanceMicros;
const x402Client = (env: TestEnv) => createPolicyClient({ policy: policy(), signer: privateKeyToAccount(generatePrivateKey()), fetch: env.fetch });

describe("kernel: a second product is billed by the platform", () => {
  let env: TestEnv;
  let acme: AcmeProduct;
  beforeEach(async () => {
    ({ env, acme } = await setup());
  });

  it("advertises the product's own price, description and credits alternative in the 402", async () => {
    const res = await env.fetch(READING);
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", amount: "50000", payTo: PAY_TO });
    expect(pr.resource).toMatchObject({ url: READING, description: "Latest reading for a site" });
    expect((await res.json()).credits.price_gbp).toBe(0.04);

    // Requirements are cached per resource: a different price on the same product.
    const report = decodePaymentRequiredHeader((await env.fetch(`${BASE_URL}/v1/acme/north/reports/r1`)).headers.get("PAYMENT-REQUIRED")!);
    expect(report.accepts[0]!.amount).toBe("10000");
  });

  it("x402: serves, settles and books revenue to the product's own account", async () => {
    const res = await x402Client(env).fetch(READING);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ site: "north", value: 42, mode: "live" });
    const id = res.headers.get("X-Payment-Id")!;
    expect((await env.store.getPayment(id))!.endpoint).toBe("acme.reading");

    await env.deps.settler.tick(new Date(Date.now() + 10_000));
    const [j] = await env.store.journal();
    // 0.05 USD × 0.8 = £0.04 gross; VAT = gross ÷ 6.
    expect(j!.lines).toEqual([
      { account: "asset:usdc_wallet", debit: 40_000, credit: 0 },
      { account: "revenue:acme", debit: 0, credit: 33_333 },
      { account: "liability:vat_output", debit: 0, credit: 6_667 },
    ]);
    expect(j!.memo.endpoint).toBe("acme.reading");
  });

  it("credits: debits the product's credits price and books revenue to the product", async () => {
    const { key, accountId } = await fundedKey(env);
    const res = await env.fetch(READING, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Credits-Charged-Gbp-Micros")).toBe("40000");
    expect(await balance(env, accountId)).toBe(10_000_000 - 40_000);
    expect((await env.store.usage(accountId, 1))[0]).toMatchObject({ endpoint: "acme.reading", micros: 40_000 });
    const usage = (await env.store.journal()).find((e) => e.kind === "credits_usage")!;
    expect(usage.lines).toEqual([
      { account: "liability:customer_credits", debit: 40_000, credit: 0 },
      { account: "revenue:acme", debit: 0, credit: 40_000 },
    ]);
  });

  it("splits revenue per product when both are sold, and VAT box 6 counts every product", async () => {
    const client = x402Client(env);
    expect((await client.fetch(READING)).status).toBe(200);
    expect((await client.fetch(`${BASE_URL}/v1/maritime/dover/vessels`)).status).toBe(200);
    await env.deps.settler.tick(new Date(Date.now() + 10_000));

    const summary = await (await env.fetch(`${BASE_URL}/admin/summary`, { headers: admin })).json();
    expect(summary.ledger_balances_gbp["revenue:acme"]).toBeCloseTo(-0.033333, 6);
    expect(summary.ledger_balances_gbp["revenue:maritime"]).toBeCloseTo(-0.023333, 6); // $0.035 x 0.8 FX / 1.2 VAT
    const vat = await (await env.fetch(`${BASE_URL}/admin/vat-summary`, { headers: admin })).json();
    expect(vat.box6_total_sales_ex_vat_gbp).toBeCloseTo(0.033333 + 0.023333, 6);
    expect(verifyChain(await env.store.journal())).toEqual({ ok: true });
  });
});

describe("kernel invariants hold for any product", () => {
  let env: TestEnv;
  let acme: AcmeProduct;
  beforeEach(async () => {
    ({ env, acme } = await setup());
  });

  it("unknown scope is a free 404 from the product, before any payment handling", async () => {
    const { key, accountId } = await fundedKey(env);
    const res = await env.fetch(`${BASE_URL}/v1/acme/south/reading`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_site");
    expect(await balance(env, accountId)).toBe(10_000_000);
  });

  it("I1: never charges for stale data, on either rail", async () => {
    acme.fresh = false;
    const { key, accountId } = await fundedKey(env);
    const credits = await env.fetch(READING, { headers: { authorization: `Bearer ${key}` } });
    expect(credits.status).toBe(503);
    expect(credits.headers.get("Retry-After")).toBe("30");
    expect((await credits.json()).error).toBe("data_stale");
    expect(await balance(env, accountId)).toBe(10_000_000);

    const client = x402Client(env);
    expect((await client.fetch(READING)).status).toBe(503);
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(0);
    expect(client.spendLog.spentToday("USD")).toBe(0);
    expect(acme.handlerCalls).toBe(0);
  });

  it("I2: never sells non-live data on mainnet, but sells live data there", async () => {
    ({ env, acme } = await setup({ X402_NETWORK: "eip155:8453" }));
    acme.mode = "simulated";
    const sim = await env.fetch(READING);
    expect(sim.status).toBe(503);
    expect((await sim.json()).error).toBe("not_for_sale");
    acme.mode = "replay";
    expect((await env.fetch(READING)).status).toBe(503);
    acme.mode = "live";
    expect((await env.fetch(READING)).status).toBe(402);
  });

  it("simulated data may be sold on testnet (staging)", async () => {
    acme.mode = "simulated";
    expect((await env.fetch(READING)).status).toBe(402);
  });

  it("I5: a product precheck refusal is never charged, on either rail", async () => {
    const { key, accountId } = await fundedKey(env);
    const missing = `${BASE_URL}/v1/acme/north/reports/missing`;
    const credits = await env.fetch(missing, { headers: { authorization: `Bearer ${key}` } });
    expect(credits.status).toBe(404);
    expect((await credits.json()).error).toBe("report_not_found");
    expect(await balance(env, accountId)).toBe(10_000_000);

    const client = x402Client(env);
    expect((await client.fetch(missing)).status).toBe(404);
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(0);
    expect(client.spendLog.spentToday("USD")).toBe(0);
  });

  it("I5: a failing handler refunds credits with a reversing journal against the product", async () => {
    acme.handlerStatus = 500;
    const { key, accountId } = await fundedKey(env);
    const res = await env.fetch(READING, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Credits-Charged-Gbp-Micros")).toBe("0");
    expect(await balance(env, accountId)).toBe(10_000_000);
    const refund = (await env.store.journal()).find((e) => e.kind === "credits_refund")!;
    expect(refund.lines).toEqual([
      { account: "revenue:acme", debit: 40_000, credit: 0 },
      { account: "liability:customer_credits", debit: 0, credit: 40_000 },
    ]);
  });

  it("I5: a failing handler cancels an async x402 payment, which is never settled", async () => {
    acme.handlerStatus = 502;
    const res = await x402Client(env).fetch(READING);
    expect(res.status).toBe(502);
    const [p] = await env.store.listPayments({ limit: 1 });
    expect(p).toMatchObject({ status: "cancelled", endpoint: "acme.reading" });
    expect((await env.store.exposure()).totalAtomic).toBe(0n);
    await env.deps.settler.tick(new Date(Date.now() + 10_000));
    expect(env.facilitator.settled).toHaveLength(0);
    expect(await env.store.journal()).toHaveLength(0);
  });

  it("I3: a payment signature for one product cannot be replayed, on the same or another resource", async () => {
    const seen: Request[] = [];
    const spy = ((i: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(i, init);
      seen.push(r.clone());
      return env.fetch(r);
    }) as typeof fetch;
    const client = createPolicyClient({ policy: policy(), signer: privateKeyToAccount(generatePrivateKey()), fetch: spy });
    expect((await client.fetch(READING)).status).toBe(200);
    const sig = seen.find((r) => r.headers.get("PAYMENT-SIGNATURE"))!.headers.get("PAYMENT-SIGNATURE")!;
    const replay = await env.fetch(READING, { headers: { "PAYMENT-SIGNATURE": sig } });
    expect(replay.status).toBe(402);
    // Paid for acme.reading (0.05); presenting it for acme.report (0.01) must not match its requirements.
    const other = await env.fetch(`${BASE_URL}/v1/acme/north/reports/r1`, { headers: { "PAYMENT-SIGNATURE": sig } });
    expect(other.status).toBe(402);
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(1);
  });
});

describe("platform surfaces are generated from the catalog", () => {
  let env: TestEnv;
  let acme: AcmeProduct;
  beforeEach(async () => {
    ({ env, acme } = await setup());
  });

  it("lists products and their resources with prices", async () => {
    const all = await (await env.fetch(`${BASE_URL}/v1/products`)).json();
    expect(all.data.map((p: { id: string }) => p.id)).toEqual(["maritime", "acme"]);
    const one = await (await env.fetch(`${BASE_URL}/v1/products/acme`)).json();
    expect(one.resources).toEqual([
      { id: "acme.reading", path: `${BASE_URL}/v1/acme/:site/reading`, description: "Latest reading for a site", price_usdc: "0.05", price_credits_gbp: 0.04 },
      { id: "acme.report", path: `${BASE_URL}/v1/acme/:site/reports/:report`, description: "One report", price_usdc: "0.01", price_credits_gbp: 0.008 },
    ]);
    expect(one.status.ready).toBe(true);
    const unknown = await env.fetch(`${BASE_URL}/v1/products/nope`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).products).toEqual(["maritime", "acme"]);
  });

  it("serves the product's free routes without payment", async () => {
    const res = await env.fetch(`${BASE_URL}/v1/acme/sites`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ["north"] });
  });

  it("puts product operator routes behind admin auth", async () => {
    expect((await env.fetch(`${BASE_URL}/admin/acme/reset`, { method: "POST" })).status).toBe(401);
    expect((await env.fetch(`${BASE_URL}/admin/acme/reset`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(acme.adminCalls).toBe(0);
    expect((await env.fetch(`${BASE_URL}/admin/acme/reset`, { method: "POST", headers: admin })).status).toBe(200);
    expect(acme.adminCalls).toBe(1);
  });

  it("stays ready when one product is unready: it reports it, and the other products keep selling", async () => {
    expect(await (await env.fetch(`${BASE_URL}/readyz`)).json()).toMatchObject({ ok: true, degraded: [] });
    acme.ready = false;
    acme.fresh = false;
    const res = await env.fetch(`${BASE_URL}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true, products: { maritime: true, acme: false }, degraded: ["acme"] });
    // The unready product refuses its own calls uncharged (I1)...
    expect((await env.fetch(READING)).status).toBe(503);
    // ...while another product still offers a sale.
    expect((await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`)).status).toBe(402);
    const m = await (await env.fetch(`${BASE_URL}/metrics`, { headers: admin })).text();
    expect(m).toContain('product_ready{product="acme"} 0');
  });

  it("a lost maritime feed (the NATS bus) degrades maritime only, not the gateway", async () => {
    const lost = await createTestEnv({}, { feedConnected: () => false, products: [new AcmeProduct()] });
    const res = await lost.fetch(`${BASE_URL}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, products: { maritime: false, acme: true }, degraded: ["maritime"] });
    expect((await lost.fetch(READING)).status).toBe(402);
  });

  it("is unready when the database is unreachable: nothing can be charged safely", async () => {
    env.store.ping = async () => false;
    const res = await env.fetch(`${BASE_URL}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: false });
  });

  it("reports every product in /status and /metrics", async () => {
    const status = await (await env.fetch(`${BASE_URL}/status`)).json();
    expect(status.products.map((p: { id: string; ready: boolean }) => [p.id, p.ready])).toEqual([
      ["maritime", true],
      ["acme", true],
    ]);
    expect(status.products[1].scopes[0]).toMatchObject({ scope: "north", fresh: true, mode: "live" });
    const metrics = await (await env.fetch(`${BASE_URL}/metrics`)).text();
    expect(metrics).toContain('product_ready{product="acme"} 1');
    expect(metrics).toContain('region_vessels{product="maritime",region="dover"}');
  });

  it("documents every product resource in OpenAPI, with legacy aliases marked deprecated", async () => {
    const doc = await (await env.fetch(`${BASE_URL}/openapi.json`)).json();
    expect(doc.tags.map((t: { name: string }) => t.name)).toEqual(["maritime", "acme"]);
    const reading = doc.paths["/v1/acme/{site}/reading"].get;
    expect(reading).toMatchObject({ operationId: "acme.reading", tags: ["acme"], "x-x402": { price_usdc: "0.05" }, "x-credits": { price_gbp: 0.04 } });
    expect(reading.parameters).toEqual([{ name: "site", in: "path", required: true, schema: { type: "string" } }]);
    expect(doc.paths["/v1/maritime/{region}/vessels"].get.deprecated).toBeUndefined();
    expect(doc.paths["/v1/{region}/vessels"].get).toMatchObject({ deprecated: true, operationId: "maritime.vessels.legacy" });
    expect(doc.paths["/v1/acme/sites"]).toBeDefined();
  });
});
