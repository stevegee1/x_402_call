import { createPolicyClient, DEFAULT_BREAKERS, type Policy, type PolicyEvent } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, chainOf, createTestEnv, type TestEnv } from "../helpers";
import { AcmeProduct } from "../platform/fake-product";

/**
 * I14, paid means delivered. In sync mode the handler runs first and its response is released only
 * once the payment settles, so a handler failure is never charged. A payment that settled but whose
 * response never reached the buyer (settle outcome unknown, client gone, replica died) is owed: the
 * identical PAYMENT-SIGNATURE resent for the same path is served once, with no second charge.
 */

const READING = `${BASE_URL}/v1/acme/north/reading`;

const policy = (): Policy => ({
  agentId: "test-agent",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  dailyBudgetGbp: 5,
  allowedNetworks: ["eip155:84532"],
  allowedOrigins: [BASE_URL],
  breakers: DEFAULT_BREAKERS,
});

type OwedResend = NonNullable<Parameters<typeof createPolicyClient>[0]["owedResend"]>;

/** A paying buyer that keeps every PAYMENT-SIGNATURE it sent, so a test can resend one. */
function buyer(env: TestEnv, owedResend: OwedResend = { attempts: 0 }, wrap?: (f: typeof fetch) => typeof fetch) {
  const sent: string[] = [];
  const events: PolicyEvent[] = [];
  const recording = ((input: string | URL | Request, init?: RequestInit) => {
    const sig = new Headers(init?.headers).get("payment-signature") ?? (input instanceof Request ? input.headers.get("payment-signature") : null);
    if (sig) sent.push(sig);
    return env.fetch(input, init);
  }) as typeof fetch;
  const client = createPolicyClient({ policy: policy(), signer: privateKeyToAccount(generatePrivateKey()), fetch: wrap ? wrap(recording) : recording, owedResend, onEvent: (e) => events.push(e) });
  return { fetch: client.fetch, spendLog: client.spendLog, lastSignature: () => sent.at(-1)!, sent: () => [...sent], events };
}

const resend = (env: TestEnv, sig: string, url = READING, init: RequestInit = {}) => env.fetch(url, { ...init, headers: { "payment-signature": sig } });
const errorOf = (res: Response) => decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error;
/** Lets the settlement worker run as if `ms` had passed. */
const workerAfter = (env: TestEnv, ms: number) => env.deps.settler.tick(new Date(Date.now() + ms));

describe("I14: paid means delivered (sync settlement)", () => {
  let env: TestEnv;
  let acme: AcmeProduct;
  beforeEach(async () => {
    acme = new AcmeProduct();
    env = await createTestEnv({ SETTLEMENT_MODE: "sync" }, { products: [acme] });
  });

  /** A payment whose settle timed out on the request path and then settled in the worker. */
  async function settledAfterTimeout(b = buyer(env)) {
    env.facilitator.settleThrows = "timeout of 10000ms exceeded";
    const first = await b.fetch(READING);
    env.facilitator.settleThrows = undefined;
    const id = (await first.json()).payment_id as string;
    await workerAfter(env, 5_000);
    return { b, id, sig: b.lastSignature() };
  }

  describe("a handler failure is never charged", () => {
    it("runs the handler before settling: a failure cancels the payment, nothing moves", async () => {
      const b = buyer(env, { sleep: async () => expect.fail("nothing is owed: must not resend") });
      acme.handlerStatus = 500;
      const res = await b.fetch(READING);
      expect(res.status).toBe(500);
      expect(res.headers.get("X-Payment-Owed")).toBeNull();
      expect(res.headers.get("X-Settlement")).toBeNull();
      expect(env.facilitator.settleCalls).toBe(0);
      const [row] = await env.store.listPayments({ limit: 1 });
      expect(row).toMatchObject({ status: "cancelled", error: "handler_status_500" });
      await workerAfter(env, 10 * 60_000); // the worker never picks it up later
      expect(env.facilitator.settled).toHaveLength(0);
    });

    it("a client gone before the settle is not charged either", async () => {
      const b = buyer(env);
      const abort = new AbortController();
      abort.abort();
      await b.fetch(new Request(READING, { signal: abort.signal }));
      expect(env.facilitator.settleCalls).toBe(0);
      const [row] = await env.store.listPayments({ limit: 1 });
      expect(row).toMatchObject({ status: "cancelled", error: "client_gone_before_settle" });
    });

    it("the data is released only once paid: a settle that fails for good returns no data", async () => {
      const b = buyer(env);
      env.facilitator.settleFails = "invalid_exact_evm_insufficient_balance";
      const res = await b.fetch(READING);
      expect(res.status).toBe(402);
      expect(errorOf(res)).toBe("settlement_failed: invalid_exact_evm_insufficient_balance");
      expect(await res.json()).not.toHaveProperty("site"); // the handler's response was discarded...
      expect(res.headers.get("X-Acme-Reading")).toBeNull(); // ...headers included
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });
  });

  describe("the settle outcome was unknown on the request path", () => {
    it("owes the payment from admission, and serves it once it settles, without charging again", async () => {
      const b = buyer(env);
      env.facilitator.settleThrows = "timeout of 10000ms exceeded";
      const first = await b.fetch(READING);
      expect(first.status).toBe(503);
      const body = await first.json();
      expect(body).toMatchObject({ error: "settlement_pending" });
      expect(body.detail).toMatch(/Resend the same PAYMENT-SIGNATURE/);
      const id = body.payment_id as string;
      expect(first.headers.get("X-Payment-Id")).toBe(id);
      expect(first.headers.get("Retry-After")).toBe("5");
      expect((await env.store.getPayment(id))!.owedSince).toBeInstanceOf(Date); // recorded before any money moved

      // Resent before the worker finishes: still settling, nothing served.
      const sig = b.lastSignature();
      const early = await resend(env, sig);
      expect(early.status).toBe(503);
      expect((await early.json()).error).toBe("settlement_pending");
      expect(acme.handlerCalls).toBe(1); // the original, whose response was withheld

      env.facilitator.settleThrows = undefined;
      await workerAfter(env, 5_000);
      expect(env.facilitator.settled).toHaveLength(1);
      expect(await (await env.fetch(`${BASE_URL}/v1/payments/${id}`)).json()).toMatchObject({ status: "settled", data_owed: true });

      const settleCalls = env.facilitator.settleCalls;
      const got = await resend(env, sig);
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({ site: "north", value: 42 });
      expect(got.headers.get("X-Settlement")).toBe("settled");
      expect(got.headers.get("X-Payment-Id")).toBe(id);
      expect(got.headers.get("X-Payment-Owed")).toBeNull();
      expect(decodePaymentResponseHeader(got.headers.get("PAYMENT-RESPONSE")!)).toMatchObject({ success: true, transaction: env.facilitator.settled[0] });
      expect(env.facilitator.settleCalls).toBe(settleCalls); // no facilitator call, no second charge
      expect(await (await env.fetch(`${BASE_URL}/v1/payments/${id}`)).json()).toMatchObject({ data_owed: false });

      // Delivered exactly once: a further resend is a replay.
      const again = await resend(env, sig);
      expect(again.status).toBe(402);
      expect(errorOf(again)).toBe("payment_already_used");
      expect(acme.handlerCalls).toBe(2);
      expect((await env.store.journal()).filter((j) => j.ref === id)).toHaveLength(1);
    });

    it("if it then fails for good, a resend says not charged and serves nothing", async () => {
      const b = buyer(env);
      env.facilitator.settleThrows = "socket hang up";
      expect((await b.fetch(READING)).status).toBe(503);
      env.facilitator.settleThrows = undefined;
      env.facilitator.settleFails = "invalid_exact_evm_insufficient_balance";
      await workerAfter(env, 5_000);

      const res = await resend(env, b.lastSignature());
      expect(res.status).toBe(402);
      expect(errorOf(res)).toMatch(/^settlement_failed: invalid_exact_evm_insufficient_balance/);
      expect(acme.handlerCalls).toBe(1);
      const [row] = await env.store.listPayments({ limit: 1 });
      expect(await (await env.fetch(`${BASE_URL}/v1/payments/${row!.id}`)).json()).toMatchObject({ status: "failed", data_owed: false });
    });

    it("a redemption whose handler fails stays owed for the next resend", async () => {
      const { sig } = await settledAfterTimeout();
      acme.handlerStatus = 503;
      const down = await resend(env, sig);
      expect(down.status).toBe(503);
      expect(down.headers.get("X-Payment-Owed")).toBe("true");
      acme.handlerStatus = 200;
      expect((await resend(env, sig)).status).toBe(200);
      expect((await resend(env, sig)).status).toBe(402);
      const m = env.deps.metrics.render();
      expect(m).toMatch(/x402_owed_redeemed_total\{resource="acme.reading",result="handler_failed"\} 1/);
      expect(m).toMatch(/x402_owed_redeemed_total\{resource="acme.reading",result="delivered"\} 1/);
    });

    it("a resend refused before the handler (stale data) is flagged owed, not 'not charged'", async () => {
      const { sig, id } = await settledAfterTimeout();
      acme.fresh = false;
      const stale = await resend(env, sig);
      expect(stale.status).toBe(503);
      expect(stale.headers.get("X-Payment-Owed")).toBe("true");
      expect(stale.headers.get("X-Payment-Id")).toBe(id);
      acme.fresh = true;
      expect((await resend(env, sig)).status).toBe(200);
    });

    it("only one of two concurrent resends delivers; the other is told to wait", async () => {
      const { sig } = await settledAfterTimeout();
      const [x, y] = await Promise.all([resend(env, sig), resend(env, sig)]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const loser = x.status === 409 ? x : y;
      expect(await loser.json()).toMatchObject({ error: "redemption_in_progress" });
      expect(loser.headers.get("Retry-After")).toBe("2");
    });

    it("a debt stays redeemable after the price list changes (lookup precedes matching)", async () => {
      const { sig } = await settledAfterTimeout();
      const real = env.deps.requirements.get.bind(env.deps.requirements);
      env.deps.requirements.get = async (r) => (await real(r)).map((x) => ({ ...x, amount: String(BigInt(x.amount) * 2n) }));
      expect((await resend(env, sig)).status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1);
    });
  });

  describe("the buyer hung up after paying", () => {
    it("a client gone during the settle is owed the data it never received", async () => {
      const b = buyer(env);
      const abort = new AbortController();
      env.facilitator.onSettle = () => abort.abort(); // the buyer gives up while the chain is slow
      const res = await b.fetch(new Request(READING, { signal: abort.signal }));
      env.facilitator.onSettle = undefined;
      const id = res.headers.get("X-Payment-Id")!;
      expect(res.headers.get("X-Payment-Owed")).toBe("true");
      const row = (await env.store.getPayment(id))!;
      expect(row.status).toBe("settled");
      expect(row.owedSince).not.toBeNull();
      expect(env.deps.metrics.render()).toMatch(/x402_owed_total\{reason="client_gone",resource="acme.reading"\} 1/);
      expect((await resend(env, b.lastSignature())).status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1);
    });
  });

  describe("what a resend can never do", () => {
    it("redeem another path than the one paid for, or redeem with a HEAD", async () => {
      const mEnv = await createTestEnv({ SETTLEMENT_MODE: "sync" });
      const b = buyer(mEnv);
      mEnv.facilitator.settleThrows = "timeout";
      expect((await b.fetch(`${BASE_URL}/v1/maritime/dover/vessels`)).status).toBe(503);
      mEnv.facilitator.settleThrows = undefined;
      await mEnv.deps.settler.tick(new Date(Date.now() + 5_000));
      const sig = b.lastSignature();
      expect((await resend(mEnv, sig, `${BASE_URL}/v1/maritime/rotterdam/vessels`)).status).toBe(402); // same resource id and price, other path
      expect((await resend(mEnv, sig, `${BASE_URL}/v1/maritime/dover/vessels`, { method: "HEAD" })).status).toBe(405);
      expect((await resend(mEnv, sig, `${BASE_URL}/v1/maritime/dover/vessels`)).status).toBe(200);
    });

    it("redeem with a different signature over the same nonce", async () => {
      const { sig } = await settledAfterTimeout();
      const decoded = JSON.parse(Buffer.from(sig, "base64").toString());
      decoded.payload.signature = `0x${"11".repeat(65)}`;
      const res = await resend(env, Buffer.from(JSON.stringify(decoded)).toString("base64"));
      expect(res.status).toBe(402);
      expect(errorOf(res)).toBe("payment_already_used");
    });

    it("replay a payment whose data was delivered (the normal case)", async () => {
      const b = buyer(env);
      expect((await b.fetch(READING)).status).toBe(200);
      const res = await resend(env, b.lastSignature());
      expect(res.status).toBe(402);
      expect(errorOf(res)).toBe("payment_already_used");
      expect(acme.handlerCalls).toBe(1);
    });

    it("replay a served-early async payment", async () => {
      const asyncEnv = await createTestEnv({}, { products: [new AcmeProduct()] });
      const b = buyer(asyncEnv);
      expect((await b.fetch(READING)).headers.get("X-Settlement")).toBe("pending");
      const res = await resend(asyncEnv, b.lastSignature());
      expect(res.status).toBe(402);
      expect(errorOf(res)).toBe("payment_already_used");
      expect(asyncEnv.facilitator.settleCalls).toBe(0); // answered from our record, not the facilitator
    });
  });

  describe("the buyer SDK", () => {
    it("waits out settlement_pending and returns the data, signing once", async () => {
      const waits: number[] = [];
      env.facilitator.settleThrows = "timeout of 10000ms exceeded";
      const b = buyer(env, {
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 2) {
            env.facilitator.settleThrows = undefined;
            await workerAfter(env, 5_000); // the seller's worker makes progress while the agent waits
          }
        },
      });
      const res = await b.fetch(READING);
      expect(res.status).toBe(200);
      expect(waits).toEqual([5_000, 5_000]);
      expect(env.facilitator.settled).toHaveLength(1);
      expect(new Set(b.sent()).size).toBe(1);
      expect(b.spendLog.spentToday("USD")).toBeCloseTo(0.05);
    });

    it("when its resends run out, the next call resends the same payment instead of paying again", async () => {
      env.facilitator.settleThrows = "timeout";
      const b = buyer(env, { attempts: 1, sleep: async () => {} });
      expect((await b.fetch(READING)).status).toBe(503);
      env.facilitator.settleThrows = undefined;
      await workerAfter(env, 5_000);
      const res = await b.fetch(READING);
      expect(res.status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1); // one payment for one delivery
      expect(new Set(b.sent()).size).toBe(1);
      expect(b.spendLog.spentToday("USD")).toBeCloseTo(0.05); // counted once
      // Delivered: the debt is forgotten, so the call after that pays normally.
      expect((await b.fetch(READING)).status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(2);
    });

    it("a paid request that dies in flight is remembered and counted, never paid twice", async () => {
      let killPaid = true;
      const b = buyer(env, { sleep: async () => {} }, (f) =>
        ((input: string | URL | Request, init?: RequestInit) => {
          const req = new Request(input, init);
          if (req.headers.get("payment-signature") && killPaid) {
            killPaid = false;
            // The seller gets the request and settles it; the buyer's connection dies meanwhile.
            const abort = new AbortController();
            env.facilitator.onSettle = () => abort.abort();
            return f(new Request(req, { signal: abort.signal })).then(() => {
              env.facilitator.onSettle = undefined;
              return Promise.reject(new TypeError("fetch failed: socket hang up"));
            });
          }
          return f(req);
        }) as typeof fetch,
      );
      await expect(b.fetch(READING)).rejects.toThrow(/socket hang up/);
      expect(env.facilitator.settled).toHaveLength(1); // the money moved
      expect(b.spendLog.spentToday("USD")).toBeCloseTo(0.05); // and the agent's budget knows
      const res = await b.fetch(READING);
      expect(res.status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1); // delivered from the same payment
      expect(new Set(b.sent()).size).toBe(1);
      expect(b.spendLog.spentToday("USD")).toBeCloseTo(0.05);
    });

    it("keeps an undelivered debt and resends it on the next call instead of signing a new one", async () => {
      env.facilitator.settleThrows = "timeout";
      const b = buyer(env, { attempts: 0 });
      expect((await b.fetch(READING)).status).toBe(503);
      expect((await b.fetch(READING)).status).toBe(503); // resends debt 1 (still pending) and returns that
      expect(new Set(b.sent()).size).toBe(1);
      env.facilitator.settleThrows = undefined;
      await workerAfter(env, 5_000);
      expect((await b.fetch(READING)).status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1);
    });

    it("drops a debt the seller can't deliver (owed, refused with a 4xx) and says so", async () => {
      const b = buyer(env, { sleep: async () => {} });
      env.facilitator.settleThrows = "timeout";
      await b.fetch(READING);
      env.facilitator.settleThrows = undefined;
      await workerAfter(env, 5_000);
      acme.handlerStatus = 404; // say the reading is gone for good
      const res = await b.fetch(READING);
      expect(res.headers.get("X-Payment-Owed")).toBe("true");
      const dropped = b.events.filter((e) => e.type === "owed_dropped");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.reason).toMatch(/contact the seller with payment/);
    });

    it("never resends an ordinary failure", async () => {
      const b = buyer(env, { sleep: async () => expect.fail("must not wait") });
      acme.fresh = false;
      expect((await b.fetch(READING)).status).toBe(503); // data_stale: not charged, nothing owed
      acme.fresh = true;
      acme.handlerStatus = 500;
      expect((await b.fetch(READING)).status).toBe(500); // cancelled, not charged
    });
  });

  describe("critic round 3 regressions", () => {
    /** Production wiring: the settler resolves unknown outcomes from the chain. */
    async function withChain() {
      const a = new AcmeProduct();
      const e = await createTestEnv({ SETTLEMENT_MODE: "sync" }, { products: [a] });
      // The checker must see the env's own facilitator, so build it after and wire it in. `mined`
      // lets a test hold a broadcast transaction out of the chain's view for a while.
      const chain = { mined: true };
      const spent = chainOf(e.facilitator);
      (e.deps.settler as unknown as { checker: unknown }).checker = { isUsed: async (x: string, y: string, n: string) => chain.mined && (await spent.isUsed(x, y, n)) };
      return { e, a, chain };
    }

    it("the facilitator's own settlement_pending (broadcast, receipt timed out) is never 'not charged'", async () => {
      const { e, a, chain } = await withChain();
      const b = buyer(e);
      chain.mined = false; // broadcast, not yet in a block: the chain still says "unused"
      e.facilitator.settlePendingAfterBroadcast = true;
      const first = await b.fetch(READING);
      expect(first.status).toBe(503); // was 402 settlement_failed: the buyer then paid again
      expect((await first.json()).error).toBe("settlement_pending");
      e.facilitator.settlePendingAfterBroadcast = false;
      chain.mined = true;
      await e.deps.settler.tick(new Date(Date.now() + 5_000)); // it mines; the chain says the nonce is spent
      const [row] = await e.store.listPayments({ limit: 1 });
      expect(row!.status).toBe("settled");
      expect((await resend(e, b.lastSignature())).status).toBe(200);
      expect(e.facilitator.settled).toHaveLength(1);
      expect(a.handlerCalls).toBe(2);
    });

    it("a resend of a debt that is still settling, refused before the handler, keeps the debt", async () => {
      const b = buyer(env, { attempts: 0 });
      env.facilitator.settleThrows = "timeout";
      expect((await b.fetch(READING)).status).toBe(503);
      acme.fresh = false;
      const stale = await resend(env, b.lastSignature());
      expect(stale.status).toBe(503);
      expect(stale.headers.get("X-Payment-Owed")).toBe("true"); // still 'verified': flagged anyway
      // The SDK keeps it: the next call (data fresh, settled) delivers that payment, not a new one.
      expect((await b.fetch(READING)).headers.get("X-Payment-Owed")).toBe("true");
      env.facilitator.settleThrows = undefined;
      acme.fresh = true;
      await workerAfter(env, 5_000);
      expect((await b.fetch(READING)).status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1);
      expect(new Set(b.sent()).size).toBe(1);
    });

    it("a store error after the facilitator moved the funds is 'pending', and the worker finishes it", async () => {
      const { e } = await withChain();
      const b = buyer(e);
      const real = e.store.settlePayment.bind(e.store);
      let fail = true;
      e.store.settlePayment = async (...args) => {
        if (fail) {
          fail = false;
          throw new Error("connection reset");
        }
        return real(...args);
      };
      const first = await b.fetch(READING);
      expect(first.status).toBe(503); // not a bare 500
      expect((await first.json()).error).toBe("settlement_pending");
      await e.deps.settler.tick(new Date(Date.now() + 130_000)); // armed: the worker picks it up
      expect((await e.store.listPayments({ limit: 1 }))[0]!.status).toBe("settled");
      expect((await resend(e, b.lastSignature())).status).toBe(200);
      expect(e.facilitator.settled).toHaveLength(1);
    });

    it("a handler that throws is cancelled like any failure, never settled", async () => {
      const b = buyer(env);
      acme.handlerThrows = true; // Hono's onError turns it into a 500 before billing sees it
      expect((await b.fetch(READING)).status).toBe(500);
      expect((await env.store.listPayments({ limit: 1 }))[0]!.status).toBe("cancelled");
      await workerAfter(env, 24 * 3_600_000);
      expect(env.facilitator.settleCalls).toBe(0);
    });

    it("a sync payment is admitted unarmed: the worker never settles one the request path didn't", async () => {
      const b = buyer(env);
      env.facilitator.settleThrows = "timeout";
      await b.fetch(READING); // this one was armed (the request path called the facilitator)
      const armed = (await env.store.listPayments({ limit: 1 }))[0]!;
      expect(armed.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 10 * 60_000);
      env.facilitator.settleThrows = undefined;
      acme.handlerStatus = 500;
      env.store.cancelPayment = async () => {
        throw new Error("db down");
      };
      await buyer(env).fetch(READING); // a new payment that never reached the facilitator, and its cancel failed
      const unarmed = (await env.store.listPayments({ limit: 1 }))[0]!;
      expect(unarmed.status).toBe("verified");
      // Due only once the authorization has expired past the grace: never submitted, only failed.
      expect(unarmed.nextAttemptAt.getTime()).toBeGreaterThan(unarmed.validBefore.getTime() + 120_000);
      expect(unarmed.nextAttemptAt.getTime()).toBeLessThan(unarmed.validBefore.getTime() + 10 * 60_000);
    });

    it("a request that dies before arming: the debt resolves to 'not charged' after expiry, and the buyer can buy again", async () => {
      const b = buyer(env, { attempts: 0 });
      // The process dies between admission and arming (a deploy's SIGTERM, say).
      env.store.armPayment = async () => {
        throw Object.assign(new Error("killed"), { kill: true });
      };
      env.store.cancelPayment = async () => {
        throw new Error("killed");
      };
      const first = await b.fetch(READING);
      expect(first.status).toBe(503); // can't say "not charged" yet: it's unknown
      const row = (await env.store.listPayments({ limit: 1 }))[0]!;
      expect(env.facilitator.settleCalls).toBe(0);
      // Once expired past the grace, the worker fails it without ever submitting it.
      const late = row.validBefore.getTime() + 130_000;
      const realNow = Date.now;
      Date.now = () => late;
      try {
        await env.deps.settler.tick(new Date(late));
      } finally {
        Date.now = realNow;
      }
      expect(env.facilitator.settleCalls).toBe(0);
      expect((await env.store.getPayment(row.id))!.status).toBe("failed");
      // The SDK's remembered debt is refused as not charged, so it pays fresh and gets the data.
      env.store.armPayment = (await createTestEnv()).store.armPayment.bind(env.store);
      env.store.cancelPayment = (await createTestEnv()).store.cancelPayment.bind(env.store);
      const again = await b.fetch(READING);
      expect(again.status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1);
    });

    it("an arm that errors (perhaps after committing) is cancelled before the buyer hears 'not charged'", async () => {
      const b = buyer(env, { attempts: 0 });
      const realArm = env.store.armPayment.bind(env.store);
      let once = true;
      env.store.armPayment = async (id, at) => {
        await realArm(id, at); // the write commits...
        if (once) {
          once = false;
          throw new Error("connection reset"); // ...and then the reply is lost
        }
      };
      const first = await b.fetch(READING);
      expect(first.status).toBe(402);
      const row = (await env.store.listPayments({ limit: 1 }))[0]!;
      expect(row.status).toBe("cancelled"); // so "not charged" is true
      await workerAfter(env, 10 * 60_000);
      expect(env.facilitator.settleCalls).toBe(0); // the worker never charges it
      expect((await b.fetch(READING)).status).toBe(200);
      expect(env.facilitator.settled).toHaveLength(1);
    });

    it("a failed cancel after a handler failure still never charges", async () => {
      const b = buyer(env);
      acme.handlerStatus = 500;
      env.store.cancelPayment = async () => {
        throw new Error("db down");
      };
      expect((await b.fetch(READING)).status).toBe(500); // the handler's answer, not a crash
      await workerAfter(env, 24 * 3_600_000);
      expect(env.facilitator.settleCalls).toBe(0);
    });

    it("a HEAD is never charged: refused before any payment is recorded", async () => {
      const b = buyer(env);
      expect((await b.fetch(READING)).status).toBe(200);
      const sig = b.lastSignature();
      const before = (await env.store.listPayments({ limit: 10 })).length;
      const decoded = JSON.parse(Buffer.from(sig, "base64").toString());
      decoded.payload.authorization.nonce = `0x${"ab".repeat(32)}`; // a new payment, not a replay
      const head = await env.fetch(READING, { method: "HEAD", headers: { "payment-signature": Buffer.from(JSON.stringify(decoded)).toString("base64") } });
      expect(head.status).toBe(405);
      expect((await env.store.listPayments({ limit: 10 })).length).toBe(before);
    });
  });

  it("no rail charges a HEAD: refused before any key, debit or payment is looked at", async () => {
    for (const headers of [{ authorization: "Bearer mk_test_anything" }, { authorization: "Session tok" }, {}] as Record<string, string>[]) {
      const head = await env.fetch(READING, { method: "HEAD", headers });
      expect(head.status).toBe(405);
      expect(head.headers.get("allow")).toBe("GET");
    }
    expect(acme.handlerCalls).toBe(0);
    expect(await env.store.listPayments({ limit: 10 })).toHaveLength(0);
  });
});

