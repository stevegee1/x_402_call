import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, verifyChain, x402SettlementJournal } from "../../src/ledger/journal";
import type { Store } from "../../src/store/types";
import { keyHash, newAccount, newPayment, settlementJournal, topUpJournal, unbalancedJournal, usageJournal } from "./fixtures";

export interface StoreHarness {
  store: Store;
  dispose(): Promise<void>;
}

/**
 * Behavioural contract every Store implementation must satisfy. Run against MemoryStore (unit) and
 * PgStore (integration) so the in-memory store used by the e2e suite cannot drift from production.
 */
export function describeStoreContract(name: string, make: () => Promise<StoreHarness>) {
  describe(`Store contract: ${name}`, () => {
    let h: StoreHarness;
    let s: Store;
    beforeEach(async () => {
      h = await make();
      s = h.store;
    });
    afterEach(async () => {
      await h.dispose();
    });

    const fundedAccount = async (micros: number) => {
      const a = await s.createAccount(newAccount(), keyHash(), "mk_test_");
      const ref = `seed-${randomUUID()}`;
      if (micros > 0) await s.applyTopUp({ ref, accountId: a.id, netMicros: micros, vatMicros: micros / 5 }, topUpJournal(a.id, ref, micros, micros / 5));
      return a;
    };

    it("pings", async () => {
      expect(await s.ping()).toBe(true);
    });

    describe("x402 payments", () => {
      it("round-trips every field, lower-casing the payer", async () => {
        const p = newPayment({ payer: "0xABCDEF0000000000000000000000000000000001", amountAtomic: 2n ** 70n + 7n });
        expect(await s.insertPayment(p)).toBe("inserted");
        const row = await s.getPayment(p.id);
        expect(row).not.toBeNull();
        expect(row!).toMatchObject({
          id: p.id,
          network: p.network,
          payer: p.payer.toLowerCase(),
          nonce: p.nonce,
          amountAtomic: 2n ** 70n + 7n,
          endpoint: p.endpoint,
          resource: p.resource,
          status: "verified",
          payload: p.payload,
          requirements: p.requirements,
          fxRate: p.fxRate,
          fxSource: p.fxSource,
          attempts: 0,
          txHash: null,
          error: null,
          settledAt: null,
        });
        expect(row!.validBefore.getTime()).toBe(p.validBefore.getTime());
        expect(row!.nextAttemptAt.getTime()).toBe(p.nextAttemptAt.getTime());
        expect(row!.createdAt).toBeInstanceOf(Date);
      });

      it("returns null for an unknown payment", async () => {
        expect(await s.getPayment(randomUUID())).toBeNull();
      });

      it("rejects a replayed authorisation (same network, payer, nonce), case-insensitively on payer (I3)", async () => {
        const p = newPayment({ payer: "0xaaaa000000000000000000000000000000000001" });
        expect(await s.insertPayment(p)).toBe("inserted");
        expect(await s.insertPayment({ ...p, id: randomUUID() })).toBe("duplicate");
        expect(await s.insertPayment({ ...p, id: randomUUID(), payer: p.payer.toUpperCase().replace("0X", "0x") })).toBe("duplicate");
      });

      it("treats the same nonce on another network or from another payer as distinct", async () => {
        const p = newPayment();
        await s.insertPayment(p);
        expect(await s.insertPayment({ ...p, id: randomUUID(), network: "eip155:8453" })).toBe("inserted");
        expect(await s.insertPayment({ ...p, id: randomUUID(), payer: "0x" + "b".repeat(40) })).toBe("inserted");
      });

      it("claims only due, verified payments, oldest first, up to the limit", async () => {
        const now = new Date();
        const due1 = newPayment({ nextAttemptAt: new Date(now.getTime() - 3_000) });
        await s.insertPayment(due1);
        await new Promise((r) => setTimeout(r, 5));
        const due2 = newPayment({ nextAttemptAt: new Date(now.getTime() - 2_000) });
        await s.insertPayment(due2);
        await new Promise((r) => setTimeout(r, 5));
        const due3 = newPayment({ nextAttemptAt: new Date(now.getTime() - 1_000) });
        await s.insertPayment(due3);
        await s.insertPayment(newPayment({ nextAttemptAt: new Date(now.getTime() + 60_000) })); // not due
        const cancelled = newPayment({ nextAttemptAt: new Date(now.getTime() - 1_000) });
        await s.insertPayment(cancelled);
        await s.cancelPayment(cancelled.id, "handler_failed");

        const first = await s.claimDuePayments(now, 2, 30_000);
        expect(first.map((p) => p.id)).toEqual([due1.id, due2.id]);
        const second = await s.claimDuePayments(now, 10, 30_000);
        expect(second.map((p) => p.id)).toEqual([due3.id]);
      });

      it("leases claimed payments: not re-claimable until the lease expires (I7)", async () => {
        const now = new Date();
        const p = newPayment({ nextAttemptAt: new Date(now.getTime() - 1) });
        await s.insertPayment(p);
        expect(await s.claimDuePayments(now, 10, 30_000)).toHaveLength(1);
        expect(await s.claimDuePayments(now, 10, 30_000)).toHaveLength(0);
        expect(await s.claimDuePayments(new Date(now.getTime() + 29_000), 10, 30_000)).toHaveLength(0);
        const again = await s.claimDuePayments(new Date(now.getTime() + 30_001), 10, 30_000);
        expect(again.map((x) => x.id)).toEqual([p.id]);
        expect((await s.getPayment(p.id))!.nextAttemptAt.getTime()).toBe(now.getTime() + 30_001 + 30_000);
      });

      it("settles once: status, tx hash, timestamp and exactly one revenue journal", async () => {
        const p = newPayment();
        await s.insertPayment(p);
        await s.settlePayment(p.id, "0xtx1", settlementJournal(p.id));
        await s.settlePayment(p.id, "0xtx2", settlementJournal(p.id)); // duplicate settle from a slow worker
        const row = (await s.getPayment(p.id))!;
        expect(row.status).toBe("settled");
        expect(row.txHash).toBe("0xtx1");
        expect(row.settledAt).toBeInstanceOf(Date);
        const j = await s.journal();
        expect(j.filter((e) => e.ref === p.id)).toHaveLength(1);
      });

      it("lists a wallet's own payments, newest first, whatever the address casing", async () => {
        const mine = "0xABCDEF0000000000000000000000000000000002";
        const older = newPayment({ payer: mine, endpoint: "grid.intensity" });
        await s.insertPayment(older);
        await new Promise((r) => setTimeout(r, 15)); // distinct created_at
        const newer = newPayment({ payer: mine.toLowerCase(), endpoint: "sessions.usd1" });
        await s.insertPayment(newer);
        await s.insertPayment(newPayment()); // someone else's
        const a = await s.walletActivity(mine, 10);
        expect(a.payments.map((p) => p.id)).toEqual([newer.id, older.id]);
        expect(a.sessions).toEqual([]);
        expect((await s.walletActivity(mine.toLowerCase(), 1)).payments.map((p) => p.id)).toEqual([newer.id]);
        expect((await s.walletActivity("0x0000000000000000000000000000000000000009", 10)).payments).toEqual([]);
      });

      it("never settles a cancelled or failed payment", async () => {
        const a = newPayment();
        const b = newPayment();
        await s.insertPayment(a);
        await s.insertPayment(b);
        await s.cancelPayment(a.id, "handler_failed");
        await s.failPayment(b.id, "invalid_signature", true);
        await s.settlePayment(a.id, "0xtx", settlementJournal(a.id));
        await s.settlePayment(b.id, "0xtx", settlementJournal(b.id));
        expect((await s.getPayment(a.id))!.status).toBe("cancelled");
        expect((await s.getPayment(b.id))!.status).toBe("failed");
        expect(await s.journal()).toHaveLength(0);
      });

      it("rolls back settlement when the journal is unbalanced", async () => {
        const p = newPayment();
        await s.insertPayment(p);
        await expect(s.settlePayment(p.id, "0xtx", unbalancedJournal())).rejects.toThrow(/unbalanced/);
        expect((await s.getPayment(p.id))!.status).toBe("verified");
        expect(await s.journal()).toHaveLength(0);
      });

      it("records retryable failures and schedules the next attempt", async () => {
        const p = newPayment();
        await s.insertPayment(p);
        const retryAt = new Date(Date.now() + 10_000);
        await s.failPayment(p.id, "facilitator_timeout", false, retryAt);
        const row = (await s.getPayment(p.id))!;
        expect(row).toMatchObject({ status: "verified", attempts: 1, error: "facilitator_timeout" });
        expect(row.nextAttemptAt.getTime()).toBe(retryAt.getTime());
        await s.failPayment(p.id, "facilitator_timeout", true);
        expect((await s.getPayment(p.id))!).toMatchObject({ status: "failed", attempts: 2 });
      });

      it("ignores failure and cancellation once a payment is settled", async () => {
        const p = newPayment();
        await s.insertPayment(p);
        await s.settlePayment(p.id, "0xtx", settlementJournal(p.id));
        await s.failPayment(p.id, "late", true);
        await s.cancelPayment(p.id, "late");
        expect((await s.getPayment(p.id))!).toMatchObject({ status: "settled", attempts: 0, error: null });
      });

      it("lists newest first, filtered by status, up to the limit", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
          const p = newPayment();
          await s.insertPayment(p);
          ids.push(p.id);
          await new Promise((r) => setTimeout(r, 5));
        }
        await s.settlePayment(ids[0]!, "0xtx", settlementJournal(ids[0]!));
        expect((await s.listPayments({ limit: 10 })).map((p) => p.id)).toEqual([...ids].reverse());
        expect((await s.listPayments({ limit: 2 })).map((p) => p.id)).toEqual([ids[3], ids[2]]);
        expect((await s.listPayments({ status: "settled", limit: 10 })).map((p) => p.id)).toEqual([ids[0]]);
      });

      it("a plain insert defaults to async settle mode (conservative: counts as exposure)", async () => {
        const p = newPayment();
        await s.insertPayment(p);
        expect((await s.getPayment(p.id))!.settleMode).toBe("async");
        expect(await s.exposure()).toEqual({ totalAtomic: 33_000n, payers: 1 });
      });
    });

    describe("payments pagination", () => {
      it("pages newest first with an exclusive cursor, losing and repeating nothing", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 7; i++) {
          const p = newPayment();
          await s.insertPayment(p);
          ids.push(p.id);
        }
        const seen: string[] = [];
        let before: string | undefined;
        for (;;) {
          const page = await s.listPayments({ limit: 3, before });
          seen.push(...page.map((p) => p.id));
          if (page.length < 3) break;
          before = page.at(-1)!.id;
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen)).toEqual(new Set(ids));
        expect(seen).toEqual((await s.listPayments({ limit: 100 })).map((p) => p.id));
      });

      it("combines the cursor with a status filter", async () => {
        const ps = Array.from({ length: 5 }, () => newPayment());
        for (const p of ps) await s.insertPayment(p);
        await s.cancelPayment(ps[1]!.id, "x");
        await s.cancelPayment(ps[3]!.id, "x");
        const first = await s.listPayments({ status: "verified", limit: 2 });
        const rest = await s.listPayments({ status: "verified", limit: 10, before: first.at(-1)!.id });
        expect([...first, ...rest].map((p) => p.id).sort()).toEqual([ps[0]!.id, ps[2]!.id, ps[4]!.id].sort());
      });

      it("an unknown cursor returns nothing (never the first page again)", async () => {
        await s.insertPayment(newPayment());
        expect(await s.listPayments({ limit: 10, before: randomUUID() })).toEqual([]);
      });
    });

    describe("admission and exposure (R4)", () => {
      const caps = { totalAtomic: 100_000n, perPayerAtomic: 66_000n };
      const at = { asyncAttemptAt: new Date(Date.now() + 2_000), syncAttemptAt: new Date(Date.now() + 120_000) };
      const HOUR = 3_600_000;
      const failures = { holdMs: 24 * HOUR, demoteMs: 30 * 24 * HOUR };
      /** `later` moves the admission clock forward, to step past the hold or demotion window. */
      const admit = (p: ReturnType<typeof newPayment>, wantAsync = true, c = caps, later = 0) => {
        const { nextAttemptAt: _, settleMode: __, ...rest } = p;
        return s.admitPayment(rest, { wantAsync, caps: c, failures, now: new Date(Date.now() + later), ...at });
      };

      it("admits async while within both caps, and records the mode and the matching next attempt", async () => {
        const p = newPayment();
        expect(await admit(p)).toEqual({ result: "inserted", mode: "async" });
        const row = (await s.getPayment(p.id))!;
        expect(row).toMatchObject({ status: "verified", settleMode: "async" });
        expect(row.nextAttemptAt.getTime()).toBe(at.asyncAttemptAt.getTime());
        expect(await s.exposure()).toEqual({ totalAtomic: 33_000n, payers: 1 });
      });

      it("falls back to sync when the per-payer cap would be exceeded; other payers are unaffected", async () => {
        const payer = newPayment().payer;
        expect(await admit(newPayment({ payer }))).toMatchObject({ mode: "async" });
        expect(await admit(newPayment({ payer }))).toMatchObject({ mode: "async" }); // 66_000: exactly at the cap
        const third = newPayment({ payer: payer.toUpperCase().replace("0X", "0x") }); // same payer, other case
        expect(await admit(third)).toEqual({ result: "inserted", mode: "sync", syncReason: "cap" });
        expect((await s.getPayment(third.id))!.nextAttemptAt.getTime()).toBe(at.syncAttemptAt.getTime());
        expect(await admit(newPayment())).toMatchObject({ mode: "async" });
        expect(await s.exposure()).toEqual({ totalAtomic: 99_000n, payers: 2 });
      });

      it("falls back to sync when the global cap would be exceeded", async () => {
        for (let i = 0; i < 3; i++) expect(await admit(newPayment())).toMatchObject({ mode: "async" });
        expect(await admit(newPayment({ amountAtomic: 1_001n }))).toMatchObject({ mode: "sync" });
        expect(await admit(newPayment({ amountAtomic: 1_000n }))).toMatchObject({ mode: "async" }); // exactly 100_000
        expect((await s.exposure()).totalAtomic).toBe(100_000n);
      });

      it("sync admissions carry no exposure", async () => {
        expect(await admit(newPayment(), false)).toMatchObject({ mode: "sync" });
        expect(await s.exposure()).toEqual({ totalAtomic: 0n, payers: 0 });
      });

      it("a payment larger than the cap on its own is sync", async () => {
        expect(await admit(newPayment({ amountAtomic: 66_001n }))).toMatchObject({ mode: "sync" });
      });

      it("rejects a replayed authorisation whatever the mode", async () => {
        const p = newPayment();
        await admit(p);
        expect(await admit({ ...p, id: randomUUID() })).toEqual({ result: "duplicate" });
        expect(await admit({ ...p, id: randomUUID() }, false)).toEqual({ result: "duplicate" });
        expect((await s.exposure()).totalAtomic).toBe(33_000n);
      });

      it("settling, failing for good and cancelling leave open (unsettled) exposure; a retryable failure does not", async () => {
        const [a, b, c, d] = [newPayment(), newPayment(), newPayment(), newPayment()];
        for (const p of [a, b, c, d]) await admit(p, true, { totalAtomic: 1_000_000n, perPayerAtomic: 1_000_000n });
        expect((await s.exposure()).totalAtomic).toBe(132_000n);
        await s.settlePayment(a.id, "0xtx", settlementJournal(a.id));
        await s.failPayment(b.id, "insufficient_funds", true);
        await s.cancelPayment(c.id, "handler_status_502");
        await s.failPayment(d.id, "indeterminate: timeout", false, new Date(Date.now() + 1_000));
        expect(await s.exposure()).toEqual({ totalAtomic: 33_000n, payers: 1 });
      });

      it("sync admission reports no reason when async was never wanted", async () => {
        expect(await admit(newPayment(), false)).toEqual({ result: "inserted", mode: "sync" });
      });

      describe("served-early payments that fail for good", () => {
        const failServed = async (over: Parameters<typeof newPayment>[0] = {}) => {
          const p = newPayment(over);
          expect(await admit(p)).toMatchObject({ mode: "async" });
          await s.failPayment(p.id, "insufficient_funds", true);
          return p;
        };

        it("keep counting against the global cap for the hold, so the cap can't be reused", async () => {
          await failServed(); // 33_000 given away
          expect(await admit(newPayment())).toMatchObject({ mode: "async" }); // 66_000
          expect(await admit(newPayment())).toMatchObject({ mode: "async" }); // 99_000
          expect(await admit(newPayment({ amountAtomic: 1_001n }))).toEqual({ result: "inserted", mode: "sync", syncReason: "cap" });
          expect(await s.exposure()).toEqual({ totalAtomic: 66_000n, payers: 2 }); // open exposure only
        });

        it("stop counting once the hold has passed", async () => {
          for (let i = 0; i < 3; i++) await failServed();
          expect(await admit(newPayment({ amountAtomic: 1_001n }))).toMatchObject({ mode: "sync", syncReason: "cap" });
          expect(await admit(newPayment({ amountAtomic: 1_001n }), true, caps, failures.holdMs + 1_000)).toMatchObject({ mode: "async" });
        });

        it("demote their payer to sync, in any letter case, until the demotion window passes", async () => {
          const bad = await failServed();
          const upper = bad.payer.toUpperCase().replace("0X", "0x");
          expect(await admit(newPayment({ payer: upper }))).toEqual({ result: "inserted", mode: "sync", syncReason: "demoted" });
          expect(await admit(newPayment({ payer: bad.payer }), true, caps, failures.holdMs + 1_000)).toMatchObject({ syncReason: "demoted" });
          expect(await admit(newPayment({ payer: bad.payer }), true, caps, failures.demoteMs + 1_000)).toMatchObject({ mode: "async" });
          expect(await admit(newPayment())).toMatchObject({ mode: "async" }); // other payers are unaffected
        });

        it("a demoted payer's replay is still a replay", async () => {
          const bad = await failServed();
          expect(await admit({ ...bad, id: randomUUID() })).toEqual({ result: "duplicate" });
        });

        it("do not include sync failures, cancellations or retryable failures (nothing was given away)", async () => {
          const payer = newPayment().payer;
          const sync = newPayment({ payer });
          await admit(sync, false);
          await s.failPayment(sync.id, "insufficient_funds", true); // refused before serving
          const cancelled = newPayment({ payer });
          await admit(cancelled);
          await s.cancelPayment(cancelled.id, "handler_status_502"); // handler failed: nothing served
          expect(await admit(newPayment({ payer, amountAtomic: 66_000n }))).toEqual({ result: "inserted", mode: "async" });
        });
      });

      it("released exposure is available to the next admission", async () => {
        const payer = newPayment().payer;
        const first = newPayment({ payer, amountAtomic: 66_000n });
        await admit(first);
        expect(await admit(newPayment({ payer }))).toMatchObject({ mode: "sync" });
        await s.settlePayment(first.id, "0xtx", settlementJournal(first.id, first.amountAtomic));
        expect(await admit(newPayment({ payer }))).toMatchObject({ mode: "async" });
      });
    });

    describe("customer accounts", () => {
      const user = (email = `ops-${randomUUID()}@acme.test`) => ({ email, passwordHash: "scrypt$14$8$5$c2FsdA$aGFzaA" });
      const key = () => ({ hash: keyHash(), prefix: "mk_test_abcd" });
      const NOW = new Date("2026-11-08T12:00:00Z");

      it("creates the account, its first key and its user together", async () => {
        const k = key();
        const u = user();
        const r = await s.createCustomer(newAccount({ email: u.email }), u, k);
        if (r === "email_taken") throw new Error("unexpected");
        expect(r.user).toMatchObject({ accountId: r.account.id, email: u.email, passwordHash: u.passwordHash, failedLogins: 0, lockedUntil: null, lastLoginAt: null });
        expect(await s.accountByKeyHash(k.hash)).toEqual(r.account);
        expect(await s.customerByEmail(u.email.toUpperCase())).toEqual(r.user);
        expect(await s.listApiKeys(r.account.id)).toEqual([{ id: expect.any(String), prefix: k.prefix, createdAt: expect.any(Date), revokedAt: null }]);
      });

      it("refuses a second user with the same email in any case, and creates nothing for it", async () => {
        const u = user("Dup@Acme.test");
        expect(await s.createCustomer(newAccount(), u, key())).not.toBe("email_taken");
        const k = key();
        expect(await s.createCustomer(newAccount({ company: "Second Ltd" }), user("dup@ACME.test"), k)).toBe("email_taken");
        expect(await s.accountByKeyHash(k.hash)).toBeNull(); // the account and key were not kept either
      });

      it("concurrent sign-ups with one email: exactly one wins", async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => s.createCustomer(newAccount(), user("race@acme.test"), key())));
        expect(results.filter((r) => r !== "email_taken")).toHaveLength(1);
      });

      it("locks after the maximum failures, restarting the count; success clears everything", async () => {
        const r = await s.createCustomer(newAccount(), user(), key());
        if (r === "email_taken") throw new Error("unexpected");
        for (let i = 0; i < 2; i++) await s.recordLoginFailure(r.user.id, NOW, 3, 60_000);
        expect(await s.customerByEmail(r.user.email)).toMatchObject({ failedLogins: 2, lockedUntil: null });
        await s.recordLoginFailure(r.user.id, NOW, 3, 60_000);
        expect(await s.customerByEmail(r.user.email)).toMatchObject({ failedLogins: 0, lockedUntil: new Date(NOW.getTime() + 60_000) });
        await s.recordLoginFailure(r.user.id, NOW, 3, 60_000);
        await s.recordLoginSuccess(r.user.id, NOW);
        expect(await s.customerByEmail(r.user.email)).toMatchObject({ failedLogins: 0, lockedUntil: null, lastLoginAt: NOW });
      });

      it("concurrent failures all count", async () => {
        const r = await s.createCustomer(newAccount(), user(), key());
        if (r === "email_taken") throw new Error("unexpected");
        await Promise.all(Array.from({ length: 5 }, () => s.recordLoginFailure(r.user.id, NOW, 100, 60_000)));
        expect((await s.customerByEmail(r.user.email))!.failedLogins).toBe(5);
      });

      it("web sessions: found while live, gone once expired or revoked", async () => {
        const r = await s.createCustomer(newAccount(), user(), key());
        if (r === "email_taken") throw new Error("unexpected");
        await s.createWebSession("h1", r.user.id, new Date(NOW.getTime() + 1_000));
        expect(await s.webSession("h1", NOW)).toEqual({ user: r.user, account: r.account });
        expect(await s.webSession("h1", new Date(NOW.getTime() + 1_000))).toBeNull();
        await s.createWebSession("h2", r.user.id, new Date(NOW.getTime() + 60_000));
        await s.revokeWebSession("h2");
        expect(await s.webSession("h2", NOW)).toBeNull();
        expect(await s.webSession("unknown", NOW)).toBeNull();
      });

      it("the session sees the account's current balance", async () => {
        const r = await s.createCustomer(newAccount(), user(), key());
        if (r === "email_taken") throw new Error("unexpected");
        await s.createWebSession("h3", r.user.id, new Date(NOW.getTime() + 60_000));
        await s.applyTopUp({ ref: "seed-h3", accountId: r.account.id, netMicros: 5_000_000, vatMicros: 1_000_000 }, topUpJournal(r.account.id, "seed-h3", 5_000_000, 1_000_000));
        expect((await s.webSession("h3", NOW))!.account.balanceMicros).toBe(5_000_000);
      });

      it("adds and revokes keys; a revoked key stops resolving; another account can't revoke it", async () => {
        const a = await s.createCustomer(newAccount(), user(), key());
        const b = await s.createCustomer(newAccount(), user(), key());
        if (a === "email_taken" || b === "email_taken") throw new Error("unexpected");
        const h = keyHash();
        const added = await s.addApiKey(a.account.id, h, "mk_test_zzzz");
        expect(added).toMatchObject({ prefix: "mk_test_zzzz", revokedAt: null });
        expect((await s.accountByKeyHash(h))!.id).toBe(a.account.id);
        expect(await s.revokeApiKey(b.account.id, added.id)).toBe(false);
        expect(await s.revokeApiKey(a.account.id, "not-a-uuid")).toBe(false);
        expect(await s.revokeApiKey(a.account.id, added.id)).toBe(true);
        expect(await s.revokeApiKey(a.account.id, added.id)).toBe(false);
        expect(await s.accountByKeyHash(h)).toBeNull();
        const keys = await s.listApiKeys(a.account.id);
        expect(keys).toHaveLength(2);
        expect(keys.find((k) => k.id === added.id)!.revokedAt).toBeInstanceOf(Date);
      });
    });

    describe("credits", () => {
      it("creates an active, zero-balance account with an upper-cased country, found by key hash", async () => {
        const h = keyHash();
        const a = await s.createAccount(newAccount({ country: "nl", taxId: "NL123" }), h, "mk_live_ab");
        expect(a).toMatchObject({ company: "Acme Shipping Ltd", email: "ops@acme.test", country: "NL", taxId: "NL123", balanceMicros: 0, status: "active" });
        expect(await s.accountByKeyHash(h)).toEqual(a);
        expect(await s.getAccount(a.id)).toEqual(a);
        expect(await s.accountByKeyHash(keyHash())).toBeNull();
        expect(await s.getAccount(randomUUID())).toBeNull();
      });

      it("debits atomically: balance, usage row and journal", async () => {
        const a = await fundedAccount(100_000);
        const r = await s.debit(a.id, 25_000, "vessels", usageJournal(a.id, 25_000));
        expect(r).toEqual({ ok: true, balanceMicros: 75_000 });
        expect((await s.getAccount(a.id))!.balanceMicros).toBe(75_000);
        const u = await s.usage(a.id, 10);
        expect(u).toHaveLength(1);
        expect(u[0]).toMatchObject({ endpoint: "vessels", micros: 25_000 });
        expect((await s.journal()).filter((e) => e.kind === "credits_usage")).toHaveLength(1);
      });

      it("allows a debit of exactly the balance", async () => {
        const a = await fundedAccount(25_000);
        expect(await s.debit(a.id, 25_000, "vessels", usageJournal(a.id, 25_000))).toEqual({ ok: true, balanceMicros: 0 });
      });

      it("refuses a debit above the balance and writes nothing (I9)", async () => {
        const a = await fundedAccount(20_000);
        const before = (await s.journal()).length;
        expect(await s.debit(a.id, 25_000, "vessels", usageJournal(a.id, 25_000))).toEqual({ ok: false, balanceMicros: 20_000 });
        expect((await s.getAccount(a.id))!.balanceMicros).toBe(20_000);
        expect(await s.usage(a.id, 10)).toHaveLength(0);
        expect(await s.journal()).toHaveLength(before);
      });

      it("refuses a debit on an unknown account", async () => {
        const id = randomUUID();
        expect(await s.debit(id, 1, "vessels", usageJournal(id, 1))).toEqual({ ok: false, balanceMicros: 0 });
      });

      it("rolls back a debit whose journal is unbalanced", async () => {
        const a = await fundedAccount(100_000);
        await expect(s.debit(a.id, 100, "vessels", unbalancedJournal())).rejects.toThrow(/unbalanced/);
        expect((await s.getAccount(a.id))!.balanceMicros).toBe(100_000);
        expect(await s.usage(a.id, 10)).toHaveLength(0);
      });

      it("refunds: balance restored, negative usage row, reversing journal", async () => {
        const a = await fundedAccount(100_000);
        await s.debit(a.id, 25_000, "vessels", usageJournal(a.id, 25_000));
        await s.refund(a.id, 25_000, usageJournal(a.id, 25_000, true));
        expect((await s.getAccount(a.id))!.balanceMicros).toBe(100_000);
        const u = await s.usage(a.id, 10);
        expect(u.map((x) => [x.endpoint, x.micros])).toEqual([
          ["refund", -25_000],
          ["vessels", 25_000],
        ]);
        expect((await s.journal()).filter((e) => e.kind === "credits_refund")).toHaveLength(1);
      });

      it("throws when refunding an unknown account, writing nothing", async () => {
        const id = randomUUID();
        await expect(s.refund(id, 1, usageJournal(id, 1, true))).rejects.toThrow(/unknown account/);
        expect(await s.journal()).toHaveLength(0);
      });

      it("applies a top-up once per reference (Stripe webhook retries are idempotent)", async () => {
        const a = await s.createAccount(newAccount(), keyHash(), "mk_test_");
        const t = { ref: "cs_test_123", accountId: a.id, netMicros: 10_000_000, vatMicros: 2_000_000 };
        expect(await s.applyTopUp(t, topUpJournal(a.id, t.ref, t.netMicros, t.vatMicros))).toBe("applied");
        expect(await s.applyTopUp(t, topUpJournal(a.id, t.ref, t.netMicros, t.vatMicros))).toBe("duplicate");
        expect((await s.getAccount(a.id))!.balanceMicros).toBe(10_000_000); // net only: VAT is a liability, not spendable credit
        expect((await s.journal()).filter((e) => e.kind === "credits_topup")).toHaveLength(1);
      });

      it("throws when topping up an unknown account, writing nothing", async () => {
        const id = randomUUID();
        await expect(s.applyTopUp({ ref: "r1", accountId: id, netMicros: 1, vatMicros: 0 }, topUpJournal(id, "r1", 1, 0))).rejects.toThrow(/unknown account/);
        expect(await s.journal()).toHaveLength(0);
      });

      it("lists usage newest first, up to the limit", async () => {
        const a = await fundedAccount(1_000_000);
        for (const ep of ["vessels", "density", "queue"]) {
          await s.debit(a.id, 1_000, ep, usageJournal(a.id, 1_000));
          await new Promise((r) => setTimeout(r, 5));
        }
        expect((await s.usage(a.id, 2)).map((u) => u.endpoint)).toEqual(["queue", "density"]);
      });
    });

    describe("ledger", () => {
      it("keeps a valid hash chain across mixed journal kinds, in sequence order (I8)", async () => {
        const a = await fundedAccount(1_000_000);
        await s.debit(a.id, 25_000, "vessels", usageJournal(a.id, 25_000));
        await s.refund(a.id, 25_000, usageJournal(a.id, 25_000, true));
        const p = newPayment();
        await s.insertPayment(p);
        await s.settlePayment(p.id, "0xtx", settlementJournal(p.id));
        const j = await s.journal();
        expect(j.map((e) => e.kind)).toEqual(["credits_topup", "credits_usage", "credits_refund", "x402_settlement"]);
        expect(j.map((e) => e.seq)).toEqual([...j.map((e) => e.seq)].sort((x, y) => x - y));
        expect(verifyChain(j)).toEqual({ ok: true });
      });

      it("keeps the chain valid for timestamps given without milliseconds or in another offset", async () => {
        const a = await s.createAccount(newAccount(), keyHash(), "mk_test_");
        const j1 = { ...topUpJournal(a.id, "r-utc", 1_000, 200), occurredAt: "2026-11-03T10:00:00Z" };
        const j2 = { ...topUpJournal(a.id, "r-off", 1_000, 200), occurredAt: "2026-11-03T11:30:00+01:00" };
        await s.applyTopUp({ ref: "r-utc", accountId: a.id, netMicros: 1_000, vatMicros: 200 }, j1);
        await s.applyTopUp({ ref: "r-off", accountId: a.id, netMicros: 1_000, vatMicros: 200 }, j2);
        const j = await s.journal();
        expect(j.map((e) => e.occurredAt)).toEqual(["2026-11-03T10:00:00.000Z", "2026-11-03T10:30:00.000Z"]);
        expect(verifyChain(j)).toEqual({ ok: true });
      });

      it("rejects an invalid journal timestamp", async () => {
        const a = await s.createAccount(newAccount(), keyHash(), "mk_test_");
        const bad = { ...topUpJournal(a.id, "r-bad", 1_000, 200), occurredAt: "not a date" };
        await expect(s.applyTopUp({ ref: "r-bad", accountId: a.id, netMicros: 1_000, vatMicros: 200 }, bad)).rejects.toThrow(/occurredAt/);
        expect((await s.getAccount(a.id))!.balanceMicros).toBe(0);
      });

      it("filters by occurredAt: from inclusive, to exclusive", async () => {
        const a = await s.createAccount(newAccount(), keyHash(), "mk_test_");
        const times = ["2026-10-01T00:00:00.000Z", "2026-10-15T00:00:00.000Z", "2026-11-01T00:00:00.000Z"];
        for (const [i, t] of times.entries()) {
          await s.applyTopUp({ ref: `r${i}`, accountId: a.id, netMicros: 1_000, vatMicros: 200 }, { ...topUpJournal(a.id, `r${i}`, 1_000, 200), occurredAt: t });
        }
        const oct = await s.journal({ from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") });
        expect(oct.map((e) => e.occurredAt)).toEqual(times.slice(0, 2));
        expect((await s.journal({ from: new Date("2026-10-15T00:00:00Z") })).map((e) => e.occurredAt)).toEqual(times.slice(1));
      });

      it("preserves memo content exactly, including key order independence and unicode", async () => {
        const p = newPayment();
        await s.insertPayment(p);
        const j = settlementJournal(p.id);
        j.memo = { z: 1, a: { y: [1, "two", null], b: "Zoë · £ · 漢字" }, fx_usdc_gbp: 0.78912345, nested: { deep: { k: true } } };
        await s.settlePayment(p.id, "0xtx", j);
        const [e] = await s.journal();
        expect(e!.memo).toEqual(j.memo);
        expect(verifyChain([e!])).toEqual({ ok: true });
      });
    });

    describe("control plane and reference data", () => {
      it("stores policy events and lists newest first", async () => {
        const a = await s.createAccount(newAccount(), keyHash(), "mk_test_");
        await s.addPolicyEvents(a.id, []);
        await s.addPolicyEvents(a.id, [{ n: 1 }, { n: 2 }]);
        await s.addPolicyEvents(a.id, [{ n: 3 }]);
        const ev = await s.listPolicyEvents(2);
        expect(ev.map((e) => e.event)).toEqual([{ n: 3 }, { n: 2 }]);
        expect(ev[0]!.accountId).toBe(a.id);
      });

      it("upserts operator conditions with their source", async () => {
        expect(await s.getCondition("panama.draught")).toBeNull();
        await s.setCondition("panama.draught", { metres: 15.2 }, "ACP advisory 41-2026");
        await s.setCondition("panama.draught", { metres: 14.9 }, "ACP advisory 42-2026");
        const c = await s.getCondition("panama.draught");
        expect(c).toMatchObject({ value: { metres: 14.9 }, source: "ACP advisory 42-2026" });
        expect(c!.updatedAt).toBeInstanceOf(Date);
      });
    });


    describe("x402 sessions", () => {
      const TTL = 3_600_000;
      /** A settled $5 session purchase at 0.8 GBP/USDC: £4.00 gross, £3.333333 net, £0.666667 VAT. */
      const boughtSession = async (amountAtomic = 5_000_000n, endpoint = "sessions.usd5") => {
        const p = newPayment({ endpoint, amountAtomic, fxRate: 0.8 });
        await s.insertPayment(p);
        await s.settlePayment(
          p.id,
          "0xtx",
          x402SettlementJournal({ paymentId: p.id, amountAtomic, fxRate: 0.8, fxSource: "fixed:test", transaction: "0xtx", payer: p.payer, network: p.network, endpoint, occurredAt: new Date().toISOString() }),
        );
        return p;
      };
      const balances = async () => {
        const b = new Map<string, number>();
        for (const j of await s.journal()) for (const l of j.lines) b.set(l.account, (b.get(l.account) ?? 0) + l.credit - l.debit);
        return b;
      };
      const use = (entries: Array<[string, bigint]>, returnedAtomic = 0n) => ({ byResource: new Map(entries), returnedAtomic });

      it("books a session purchase as a prepayment liability plus VAT, not revenue", async () => {
        await boughtSession();
        const b = await balances();
        expect(b.get(ACCOUNTS.sessionPrepaid)).toBe(3_333_333);
        expect(b.get(ACCOUNTS.vatOutput)).toBe(666_667);
        expect([...b.keys()].filter((k) => k.startsWith("revenue:"))).toEqual([]);
      });

      it("opens on first reserve from the settled payment, and leases at most what is left", async () => {
        const p = await boughtSession();
        const now = new Date();
        const r1 = await s.reserveSession(p.id, 3_000_000n, now, TTL);
        expect(r1).toMatchObject({ ok: true, grantedAtomic: 3_000_000n });
        const r2 = await s.reserveSession(p.id, 3_000_000n, now, TTL);
        expect(r2).toMatchObject({ ok: true, grantedAtomic: 2_000_000n });
        expect(await s.reserveSession(p.id, 1n, now, TTL)).toEqual({ ok: false, reason: "exhausted" });
        const sess = (await s.getSession(p.id))!;
        expect(sess).toMatchObject({ payer: p.payer.toLowerCase(), amountAtomic: 5_000_000n, reservedAtomic: 5_000_000n, spentAtomic: 0n, netGbpMicros: 3_333_333, releasedGbpMicros: 0, closedAt: null });
        const settledAt = (await s.getPayment(p.id))!.settledAt!;
        expect(sess.expiresAt.getTime()).toBe(settledAt.getTime() + TTL);
      });

      it("refuses unknown, unsettled, non-session and expired payments", async () => {
        const now = new Date();
        expect(await s.reserveSession(randomUUID(), 1n, now, TTL)).toEqual({ ok: false, reason: "unknown" });
        const pending = newPayment({ endpoint: "sessions.usd5", amountAtomic: 5_000_000n });
        await s.insertPayment(pending);
        expect(await s.reserveSession(pending.id, 1n, now, TTL)).toEqual({ ok: false, reason: "not_settled" });
        const data = newPayment();
        await s.insertPayment(data);
        await s.settlePayment(data.id, "0x1", settlementJournal(data.id));
        expect(await s.reserveSession(data.id, 1n, now, TTL)).toEqual({ ok: false, reason: "not_a_session" });
        const p = await boughtSession();
        expect(await s.reserveSession(p.id, 1n, new Date(Date.now() + TTL + 1_000), TTL)).toEqual({ ok: false, reason: "expired" });
      });

      it("never leases more than the amount when replicas reserve at the same moment", async () => {
        const p = await boughtSession(1_000_000n, "sessions.usd1");
        const now = new Date();
        const grants = await Promise.all(Array.from({ length: 12 }, () => s.reserveSession(p.id, 100_000n, now, TTL)));
        const granted = grants.reduce((n, g) => n + (g.ok ? g.grantedAtomic : 0n), 0n);
        expect(granted).toBe(1_000_000n);
        expect(grants.filter((g) => !g.ok)).toHaveLength(2);
      });

      it("moves the liability into each product's revenue as usage is reported, without rounding drift", async () => {
        const p = await boughtSession();
        const now = new Date();
        await s.reserveSession(p.id, 5_000_000n, now, TTL);
        // 1 001 reports of $0.001 and $0.002 reads across two products, then the remainder handed back.
        for (let i = 0; i < 1_001; i++) await s.recordSessionUsage(p.id, use([["grid.intensity", 1_000n], ["maritime.vessels", 2_000n]]), now);
        await s.recordSessionUsage(p.id, use([], 5_000_000n - 3_003_000n), now);
        const sess = (await s.getSession(p.id))!;
        expect(sess).toMatchObject({ spentAtomic: 3_003_000n, reservedAtomic: 3_003_000n });
        // floor(3 333 333 × 3 003 000 / 5 000 000) = 2 001 999, released over 1 001 journals.
        expect(sess.releasedGbpMicros).toBe(2_001_999);
        const b = await balances();
        expect((b.get("revenue:grid") ?? 0) + (b.get("revenue:maritime") ?? 0)).toBe(2_001_999);
        expect(b.get("revenue:maritime")! / b.get("revenue:grid")!).toBeCloseTo(2, 2);
        expect(b.get(ACCOUNTS.sessionPrepaid)).toBe(3_333_333 - 2_001_999);
        expect(verifyChain(await s.journal())).toEqual({ ok: true });
      }, 60_000);

      it("refuses usage beyond the outstanding leases and writes nothing", async () => {
        const p = await boughtSession();
        await s.reserveSession(p.id, 1_000n, new Date(), TTL);
        const before = (await s.journal()).length;
        await expect(s.recordSessionUsage(p.id, use([["grid.intensity", 1_001n]]), new Date())).rejects.toThrow(/exceeds outstanding/);
        await expect(s.recordSessionUsage(p.id, use([["grid.intensity", 600n]], 500n), new Date())).rejects.toThrow(/exceeds outstanding/);
        expect((await s.journal()).length).toBe(before);
        expect((await s.getSession(p.id))!.spentAtomic).toBe(0n);
        await expect(s.recordSessionUsage(randomUUID(), use([]), new Date())).rejects.toThrow(/unknown session/);
      });

      it("closes expired sessions after the grace period and books the unused liability as breakage", async () => {
        const p = await boughtSession();
        const t0 = new Date();
        await s.reserveSession(p.id, 5_000_000n, t0, TTL);
        await s.recordSessionUsage(p.id, use([["grid.intensity", 1_000_000n]], 4_000_000n), t0);
        const expiry = (await s.getSession(p.id))!.expiresAt.getTime();
        expect(await s.closeExpiredSessions(new Date(expiry + 60_000), 120_000)).toBe(0); // still in grace
        expect(await s.closeExpiredSessions(new Date(expiry + 120_000), 120_000)).toBe(1);
        expect(await s.closeExpiredSessions(new Date(expiry + 999_000), 120_000)).toBe(0); // once
        const b = await balances();
        expect(b.get(ACCOUNTS.sessionPrepaid)).toBe(0);
        expect(b.get("revenue:grid")).toBe(666_666); // floor(3 333 333 / 5)
        expect(b.get(ACCOUNTS.sessionBreakage)).toBe(3_333_333 - 666_666);
        expect((await s.getSession(p.id))!.closedAt).not.toBeNull();
        expect(await s.reserveSession(p.id, 1n, new Date(expiry + 999_000), TTL)).toEqual({ ok: false, reason: "closed" });
        // A late report from a replica records the spend but books nothing: the remainder is gone.
        const n = (await s.journal()).length;
        await s.recordSessionUsage(p.id, use([], 0n), new Date());
        expect((await s.journal()).length).toBe(n);
      });
    });
  });
}
