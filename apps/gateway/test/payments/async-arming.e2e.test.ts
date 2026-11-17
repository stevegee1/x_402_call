import { createPolicyClient, DEFAULT_BREAKERS } from "@mx/policy-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASYNC_SETTLE_DELAY_MS } from "../../src/payments/billing";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";
import { AcmeProduct } from "../platform/fake-product";

/**
 * I15, async payments are charged only for a response that went out. They are served before they
 * settle, but admitted unarmed: the settlement worker never submits an unarmed payment. The request
 * path arms one only after a successful response with the client still there, so a handler that is
 * slow, fails, or loses its client can never be charged, however long it takes.
 */

const READING = `${BASE_URL}/v1/acme/north/reading`;

describe("I15: async payments are armed only after a successful response", () => {
  let env: TestEnv;
  let acme: AcmeProduct;
  beforeEach(async () => {
    acme = new AcmeProduct();
    env = await createTestEnv({ SETTLEMENT_MODE: "async" }, { products: [acme] });
  });

  const client = (fetchImpl: typeof fetch = env.fetch) =>
    createPolicyClient({
      policy: { agentId: "t", maxPricePerRequestUsd: 0.1, dailyBudgetUsd: 5, dailyBudgetGbp: 5, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
      signer: privateKeyToAccount(generatePrivateKey()),
      fetch: fetchImpl,
    });
  /** Lets the settlement worker run as if `ms` had passed. */
  const workerAfter = (ms: number) => env.deps.settler.tick(new Date(Date.now() + ms));
  const only = async () => {
    const rows = await env.store.listPayments({ limit: 10 });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  /** Waits until the request has been admitted and the handler is running. */
  const admitted = async () => {
    for (let i = 0; i < 200 && (await env.store.listPayments({ limit: 1 })).length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await env.store.listPayments({ limit: 1 })).toHaveLength(1);
  };

  it("a slow handler that fails is never charged, even when the worker runs long after admission", async () => {
    // The race I15 closes: before it, the row was due 2 s after admission and a worker pass during a
    // slow handler settled it; the handler's later 500 then couldn't cancel a settled payment.
    let release!: () => void;
    acme.handlerGate = new Promise<void>((r) => (release = r));
    const pending = client().fetch(READING);
    await admitted();
    await workerAfter(10_000); // well past the old 2 s settle delay, while the handler is still running
    expect(env.facilitator.settleCalls).toBe(0);
    expect(await only()).toMatchObject({ status: "verified", armedAt: null });
    acme.handlerStatus = 500;
    release();
    expect((await pending).status).toBe(500);
    expect(await only()).toMatchObject({ status: "cancelled", error: "handler_status_500", settledAt: null });
    await workerAfter(60_000);
    expect(env.facilitator.settleCalls).toBe(0);
    expect((await env.store.exposure()).totalAtomic).toBe(0n); // the reservation is released
  });

  it("a successful response is armed as it goes out, then settled by the worker", async () => {
    const res = await client().fetch(READING);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-settlement")).toBe("pending");
    const row = await only();
    expect(row.armedAt).not.toBeNull();
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(ASYNC_SETTLE_DELAY_MS - 1_000);
    await workerAfter(ASYNC_SETTLE_DELAY_MS + 100);
    expect(env.facilitator.settleCalls).toBe(1);
    expect(await only()).toMatchObject({ status: "settled" });
  });

  it("a client that leaves before the response goes out is not charged", async () => {
    let release!: () => void;
    acme.handlerGate = new Promise<void>((r) => (release = r));
    const ctrl = new AbortController();
    // The client signs and sends with the abort signal; the gateway sees it on c.req.raw.signal.
    const withSignal = ((input: string | URL | Request, init?: RequestInit) => env.fetch(input, { ...init, signal: ctrl.signal })) as typeof fetch;
    const pending = client(withSignal).fetch(READING).catch(() => null);
    await admitted();
    ctrl.abort();
    release();
    await pending;
    // Let billing finish its post-handler step.
    for (let i = 0; i < 100 && (await only()).status === "verified"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await only()).toMatchObject({ status: "cancelled", error: "client_gone_before_settle" });
    await workerAfter(60_000);
    expect(env.facilitator.settleCalls).toBe(0);
  });

  it("if the payment can't be armed, the data is withheld and nothing is charged", async () => {
    env.store.armPayment = async () => {
      throw new Error("db down");
    };
    const res = await client().fetch(READING);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "payment_unavailable" });
    expect(await only()).toMatchObject({ status: "cancelled", error: "arm_failed" });
    expect(env.deps.metrics.get("x402_arm_failed_total", { resource: "acme.reading" })).toBe(1);
    await workerAfter(60_000);
    expect(env.facilitator.settleCalls).toBe(0);
  });

  it("a payment left unarmed (the replica died mid-request) is never submitted: only confirmed or expired", async () => {
    let release!: () => void;
    acme.handlerGate = new Promise<void>((r) => (release = r));
    void client().fetch(READING).catch(() => null);
    await admitted();
    const row = await only();
    // The worker first looks after the authorization has expired, and then never submits it.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(row.validBefore.getTime());
    await workerAfter(row.nextAttemptAt.getTime() - Date.now() + 1_000);
    expect(env.facilitator.settleCalls).toBe(0);
    expect((await only()).status).not.toBe("settled");
    release();
  });

  it("an async payment that was never armed is closed as cancelled, so the buyer isn't demoted as a defaulter", async () => {
    let release!: () => void;
    acme.handlerGate = new Promise<void>((r) => (release = r));
    const buyer = client();
    void buyer.fetch(READING).catch(() => null);
    await admitted();
    const row = await only();
    // Past expiry and its grace: the worker closes it (the fake chain never saw the nonce).
    await env.deps.settler.tick(new Date(row.validBefore.getTime() + 10 * 60_000));
    vi.setSystemTime(new Date(row.validBefore.getTime() + 10 * 60_000));
    await env.deps.settler.tick(new Date());
    vi.useRealTimers();
    const closed = await only();
    expect(closed).toMatchObject({ status: "cancelled", error: "never_armed" });
    expect(env.deps.metrics.get("x402_never_armed_total")).toBe(1);
    release();
  });

  it("arm committed but its reply lost, and the cancel fails too: the buyer gets the data, never a false 'not charged'", async () => {
    const realArm = env.store.armPayment.bind(env.store);
    env.store.armPayment = async (id, at) => {
      await realArm(id, at);
      throw new Error("connection reset");
    };
    env.store.cancelPayment = async () => {
      throw new Error("db down");
    };
    const res = await client().fetch(READING);
    expect(res.status).toBe(200); // outcome unknown: served, since it may be charged
    await workerAfter(ASYNC_SETTLE_DELAY_MS + 100);
    expect(env.facilitator.settleCalls).toBe(1); // it was armed, so it is paid for what was served
  });

  it("arm committed but its reply lost, cancel succeeds: 503 'not charged' is true", async () => {
    const realArm = env.store.armPayment.bind(env.store);
    env.store.armPayment = async (id, at) => {
      await realArm(id, at);
      throw new Error("connection reset");
    };
    const res = await client().fetch(READING);
    expect(res.status).toBe(503);
    expect(await only()).toMatchObject({ status: "cancelled", error: "arm_failed" });
    await workerAfter(60_000);
    expect(env.facilitator.settleCalls).toBe(0);
  });

  it("a row closed while the handler ran (arm finds nothing) withholds the data: not served, not charged", async () => {
    let release!: () => void;
    acme.handlerGate = new Promise<void>((r) => (release = r));
    const pending = client().fetch(READING);
    await admitted();
    await env.store.cancelPayment((await only()).id, "never_armed"); // the worker closed it at expiry
    release();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "payment_expired" });
    expect(env.facilitator.settleCalls).toBe(0);
  });

  it("an authorization too close to expiry to settle is not armed: data withheld, not charged", async () => {
    let release!: () => void;
    acme.handlerGate = new Promise<void>((r) => (release = r));
    const pending = client().fetch(READING);
    await admitted();
    const row = await only();
    vi.setSystemTime(new Date(row.validBefore.getTime() - 5_000)); // the handler finished 5 s before expiry
    release();
    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(503);
    expect(await only()).toMatchObject({ status: "cancelled", armedAt: null });
    expect(env.facilitator.settleCalls).toBe(0);
  });
});
