import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../apps/gateway/test/store/pg-db";
// Types only: brings in the harness's declaration of the values it provides (pgAdminUrl, pgTemplateDb).
import type {} from "../../../apps/gateway/test/store/pg-global-setup";
import { EnvCache, NOTIFY_CHANNEL, PgEnvStore, type Observation, type VersionWrite } from "../src";

const DS = "neso.carbon_intensity";
const P = 30 * 60_000;
const MIN = 60_000;
const T0 = Date.parse("2026-11-07T14:00:00Z");

const ok = (region: string, validFrom: number, value: number): Observation => ({ region, validFrom, value, quality: "ok", rawValue: null });
const write = (ingestedAt: number, observations: Observation[], dataset = DS): VersionWrite => ({ dataset, unit: "gCO2/kWh", ingestedAt, publishedAt: null, observations, dropped: 0 });

async function until(cond: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("following the version store", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: PgEnvStore;
  let sql: pg.Client;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    db = await createTestDb();
    store = new PgEnvStore(db.url);
    sql = new pg.Client({ connectionString: db.url });
    await sql.connect();
  });
  afterEach(async () => {
    for (const s of stops.splice(0)) await s();
    await sql.end();
    await store.close();
    await db.drop();
  });

  it("numbers versions in commit order and returns them incrementally", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200), ok("wales", T0, 300)]));
    await store.writeVersion(write(T0 + MIN, [ok("england", T0, 205)]));
    const all = await store.changesSince(DS, 0, 0);
    expect(all.map((r) => [r.region, r.value])).toEqual([
      ["england", 200],
      ["wales", 300],
      ["england", 205],
    ]);
    const seqs = all.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect((await store.changesSince(DS, seqs[1]!, 0)).map((r) => r.value)).toEqual([205]);
    expect(await store.changesSince(DS, seqs[2]!, 0)).toEqual([]);
    expect(await store.changesSince(DS, 0, T0 + P)).toEqual([]); // period filter
    expect(await store.changesSince(DS, 0, 0, 1)).toHaveLength(1); // page size
  });

  it("reads a consistent snapshot of the window and the seq to continue from", async () => {
    await store.writeVersion(write(T0, [ok("england", T0 - 10 * P, 1), ok("england", T0, 2), ok("wales", T0, 3), ok("scotland", T0, 4)]));
    const snap = await store.snapshot(DS, ["england", "wales"], T0 - P);
    expect(snap.rows.map((r) => [r.region, r.value])).toEqual([
      ["england", 2],
      ["wales", 3],
    ]);
    expect(snap.maxSeq).toBe(Math.max(...(await store.changesSince(DS, 0, 0)).map((r) => r.seq)));
    expect(await store.snapshot("other", ["england"], 0)).toEqual({ rows: [], maxSeq: 0 });
  });

  it("lists every revision of a period, oldest first", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200)]));
    await store.writeVersion(write(T0 + MIN, [ok("england", T0, 205)]));
    await store.writeVersion(write(T0 + 2 * MIN, [ok("england", T0, 205)])); // unchanged: no version
    const r = await store.revisions(DS, "england", T0);
    expect(r.map((x) => [x.value, x.ingestedAt])).toEqual([
      [200, T0],
      [205, T0 + MIN],
    ]);
    expect(await store.revisions(DS, "wales", T0)).toEqual([]);
  });

  it("notifies on commit only when values changed", async () => {
    const got: string[] = [];
    await sql.query(`listen ${NOTIFY_CHANNEL}`);
    sql.on("notification", (m) => got.push(m.payload!));
    await store.writeVersion(write(T0, [ok("england", T0, 200)]));
    await store.writeVersion(write(T0 + MIN, [ok("england", T0, 200)])); // no change
    await until(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([JSON.stringify({ dataset: DS })]);
  });

  it("sends no notification for a write that rolls back", async () => {
    const got: string[] = [];
    await sql.query(`listen ${NOTIFY_CHANNEL}`);
    sql.on("notification", (m) => got.push(m.payload!));
    await expect(store.writeVersion(write(T0, [ok("england", T0, 200), { ...ok("england", T0, 1), validFrom: Number.NaN }]))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);
  });

  it("listen() delivers notifications and reconnects after the connection is killed", async () => {
    const got: string[] = [];
    let reconnects = 0;
    const errors: unknown[] = [];
    stops.push(store.listen({ onNotify: (d) => got.push(d), onReconnect: () => reconnects++, onError: (e) => errors.push(e) }));
    await until(async () => (await sql.query(`select count(*)::int as n from pg_stat_activity where query = 'listen ${NOTIFY_CHANNEL}'`)).rows[0].n === 1);
    await store.writeVersion(write(T0, [ok("england", T0, 200)]));
    await until(() => got.length === 1);

    await sql.query(`select pg_terminate_backend(pid) from pg_stat_activity where query = 'listen ${NOTIFY_CHANNEL}'`);
    await until(() => reconnects === 1, 10_000);
    expect(errors.length).toBeGreaterThan(0);
    await store.writeVersion(write(T0 + MIN, [ok("england", T0, 201)]));
    await until(() => got.length === 2);
    expect(got).toEqual([DS, DS]);
  });

  it("keeps an EnvCache in step with the store through notifications", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200)]));
    const cache = new EnvCache(store, { dataset: DS, regions: ["england"], windowMs: 7 * 24 * 3_600_000 }, () => T0 + 10 * MIN);
    await cache.refresh();
    stops.push(store.listen({ onNotify: () => void cache.refresh(), onReconnect: () => void cache.refresh(), onError: () => {} }));
    await until(async () => (await sql.query(`select count(*)::int as n from pg_stat_activity where query = 'listen ${NOTIFY_CHANNEL}'`)).rows[0].n === 1);

    const writer = new PgEnvStore(db.url); // a separate process in production (ingest-env)
    try {
      await writer.writeVersion(write(T0 + MIN, [ok("england", T0, 207), ok("england", T0 + P, 190)]));
      await until(() => cache.asOf("england", T0, T0 + 2 * P).length === 2);
      expect(cache.asOf("england", T0, T0 + 2 * P).map((r) => r.value)).toEqual([207, 190]);
      expect(cache.asOf("england", T0, T0 + 2 * P, T0)).toEqual(await store.asOf({ dataset: DS, region: "england", from: T0, to: T0 + 2 * P, asOf: T0 }));
    } finally {
      await writer.close();
    }
  });
});
