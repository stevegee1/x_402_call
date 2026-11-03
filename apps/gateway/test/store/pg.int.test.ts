import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "../../src/ledger/journal";
import { migrate } from "../../src/store/migrate";
import { PgStore } from "../../src/store/pg";
import { describeStoreContract } from "./contract";
import { keyHash, newAccount, newPayment, settlementJournal, topUpJournal, usageJournal } from "./fixtures";
import { createTestDb } from "./pg-db";

describeStoreContract("PgStore", async () => {
  const db = await createTestDb();
  const store = new PgStore(db.url);
  return {
    store,
    dispose: async () => {
      await store.close();
      await db.drop();
    },
  };
});

describe("PgStore: Postgres-specific guarantees", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let a: PgStore; // replica A
  let b: PgStore; // replica B (own pool, as a second gateway task would have)
  let sql: pg.Client;

  beforeEach(async () => {
    db = await createTestDb();
    a = new PgStore(db.url);
    b = new PgStore(db.url);
    sql = new pg.Client({ connectionString: db.url });
    await sql.connect();
  });
  afterEach(async () => {
    await sql.end();
    await a.close();
    await b.close();
    await db.drop();
  });

  const funded = async (micros: number) => {
    const acct = await a.createAccount(newAccount(), keyHash(), "mk_test_");
    await a.applyTopUp({ ref: `seed-${acct.id}`, accountId: acct.id, netMicros: micros, vatMicros: 0 }, topUpJournal(acct.id, `seed-${acct.id}`, micros, 0));
    return acct;
  };

  describe("schema and migrations", () => {
    it("is idempotent and safe to run from several replicas at once", async () => {
      await Promise.all([migrate(db.url, () => {}), migrate(db.url, () => {}), migrate(db.url, () => {})]);
      const r = await sql.query<{ version: string }>("select version from schema_migrations order by version");
      expect(r.rows.map((x) => x.version)).toEqual(expect.arrayContaining(["001_init.sql", "002_ledger_no_truncate.sql"]));
      expect(new Set(r.rows.map((x) => x.version)).size).toBe(r.rows.length);
    });

    it("rejects UPDATE, DELETE and TRUNCATE on the ledger (append-only, I8)", async () => {
      await funded(1_000);
      await expect(sql.query("update ledger_journal set ref = 'tampered'")).rejects.toThrow(/append-only/);
      await expect(sql.query("delete from ledger_journal")).rejects.toThrow(/append-only/);
      await expect(sql.query("truncate ledger_journal")).rejects.toThrow(/append-only/);
      expect(verifyChain(await a.journal())).toEqual({ ok: true });
    });

    it("rejects a negative credits balance at the database level (I9)", async () => {
      const acct = await funded(1_000);
      await expect(sql.query("update credit_accounts set balance_micros = -1 where id = $1", [acct.id])).rejects.toThrow(/check constraint/);
    });

    it("rejects a non-positive x402 amount", async () => {
      await expect(a.insertPayment(newPayment({ amountAtomic: 0n }))).rejects.toThrow(/check constraint/);
    });

    it("stores uint256-sized amounts exactly (numeric(78,0))", async () => {
      const max = 2n ** 256n - 1n;
      const p = newPayment({ amountAtomic: max });
      await a.insertPayment(p);
      expect((await a.getPayment(p.id))!.amountAtomic).toBe(max);
      expect((await a.unsettledByPayer()).find((r) => r.payer === p.payer.toLowerCase())!.atomic).toBe(max);
    });
  });

  describe("concurrency across replicas", () => {
    it("I3: exactly one of many concurrent inserts of the same authorisation wins", async () => {
      const p = newPayment();
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).insertPayment({ ...p, id: randomUUID() })));
      expect(results.filter((r) => r === "inserted")).toHaveLength(1);
      expect(results.filter((r) => r === "duplicate")).toHaveLength(29);
    });

    it("I7: two replicas claiming concurrently never receive the same payment", async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 120; i++) {
        const p = newPayment();
        ids.add(p.id);
        await a.insertPayment(p);
      }
      const now = new Date();
      const claimed: string[] = [];
      const worker = async (s: PgStore) => {
        for (;;) {
          const batch = await s.claimDuePayments(now, 7, 60_000);
          if (batch.length === 0) return;
          claimed.push(...batch.map((p) => p.id));
        }
      };
      await Promise.all([worker(a), worker(b), worker(a), worker(b)]);
      expect(claimed).toHaveLength(120);
      expect(new Set(claimed)).toEqual(ids);
    });

    it("settles a payment once even when two replicas settle it at the same time", async () => {
      const p = newPayment();
      await a.insertPayment(p);
      await Promise.all([a.settlePayment(p.id, "0xa", settlementJournal(p.id)), b.settlePayment(p.id, "0xb", settlementJournal(p.id))]);
      const j = await a.journal();
      expect(j.filter((e) => e.ref === p.id)).toHaveLength(1);
      expect(["0xa", "0xb"]).toContain((await a.getPayment(p.id))!.txHash);
    });

    it("I9: concurrent debits never overdraw; exactly balance/price succeed", async () => {
      const price = 25_000;
      const acct = await funded(price * 10);
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).debit(acct.id, price, "vessels", usageJournal(acct.id, price))));
      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect((await a.getAccount(acct.id))!.balanceMicros).toBe(0);
      expect(await a.usage(acct.id, 100)).toHaveLength(10);
      expect((await a.journal()).filter((e) => e.kind === "credits_usage")).toHaveLength(10);
    });

    it("applies a top-up once when the same webhook is delivered to both replicas", async () => {
      const acct = await a.createAccount(newAccount(), keyHash(), "mk_test_");
      const t = { ref: "cs_test_dup", accountId: acct.id, netMicros: 5_000_000, vatMicros: 1_000_000 };
      const r = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).applyTopUp(t, topUpJournal(acct.id, t.ref, t.netMicros, t.vatMicros))));
      expect(r.filter((x) => x === "applied")).toHaveLength(1);
      expect((await a.getAccount(acct.id))!.balanceMicros).toBe(5_000_000);
    });

    it("I8: the hash chain stays valid and gap-free under concurrent mixed writes from two replicas", async () => {
      const acct = await funded(10_000_000);
      const writes: Promise<unknown>[] = [];
      for (let i = 0; i < 60; i++) {
        const s = i % 2 ? a : b;
        if (i % 3 === 0) writes.push(s.debit(acct.id, 1_000, "vessels", usageJournal(acct.id, 1_000)));
        else if (i % 3 === 1) writes.push(s.refund(acct.id, 500, usageJournal(acct.id, 500, true)));
        else {
          const p = newPayment();
          writes.push(s.insertPayment(p).then(() => s.settlePayment(p.id, "0xtx", settlementJournal(p.id))));
        }
      }
      await Promise.all(writes);
      const j = await a.journal();
      expect(j).toHaveLength(61);
      expect(verifyChain(j)).toEqual({ ok: true });
      const seqs = j.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      expect(new Set(j.map((e) => e.prevHash)).size).toBe(j.length); // no fork: every entry has a distinct parent
    });
  });

  it("reports unhealthy once the pool is closed", async () => {
    const s = new PgStore(db.url);
    expect(await s.ping()).toBe(true);
    await s.close();
    expect(await s.ping()).toBe(false);
  });
});
