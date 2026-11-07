import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../apps/gateway/test/store/pg-db";
// Types only: brings in the harness's declaration of the values it provides (pgAdminUrl, pgTemplateDb).
import type {} from "../../../apps/gateway/test/store/pg-global-setup";
import { MAX_ROWS, PgEnvStore, type Observation, type VersionWrite } from "../src";

const DS = "neso.carbon_intensity";
const P = 30 * 60_000;
const T0 = Date.parse("2026-11-07T14:00:00Z");
const MIN = 60_000;

const ok = (region: string, validFrom: number, value: number): Observation => ({ region, validFrom, value, quality: "ok", rawValue: null });
const write = (ingestedAt: number, observations: Observation[], extra: Partial<VersionWrite> = {}): VersionWrite => ({
  dataset: DS,
  unit: "gCO2/kWh",
  ingestedAt,
  publishedAt: ingestedAt - 20_000,
  observations,
  dropped: 0,
  ...extra,
});
const values = (rows: { value: number | null }[]) => rows.map((r) => r.value);

describe("PgEnvStore", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: PgEnvStore;
  let sql: pg.Client;

  beforeEach(async () => {
    db = await createTestDb();
    store = new PgEnvStore(db.url);
    sql = new pg.Client({ connectionString: db.url });
    await sql.connect();
  });
  afterEach(async () => {
    await sql.end();
    await store.close();
    await db.drop();
  });

  it("reports the schema as ready and answers a ping", async () => {
    expect(await store.schemaReady()).toBe(true);
    await store.ping();
    expect(typeof (await store.hypertable())).toBe("boolean");
  });

  it("appends a first version in full, then only what changed", async () => {
    const v1 = [ok("england", T0, 200), ok("england", T0 + P, 210), ok("wales", T0, 300)];
    expect(await store.writeVersion(write(T0, v1))).toBe(3);
    // Same values again: nothing appended.
    expect(await store.writeVersion(write(T0 + 10 * MIN, v1))).toBe(0);
    // One value revised, one new period appears.
    const v2 = [ok("england", T0, 200), ok("england", T0 + P, 215), ok("wales", T0, 300), ok("england", T0 + 2 * P, 190)];
    expect(await store.writeVersion(write(T0 + 20 * MIN, v2))).toBe(2);
    const n = await sql.query("select count(*)::int as n from env_observation");
    expect(n.rows[0].n).toBe(5);
  });

  it("answers as-of queries with the version that was current then", async () => {
    await store.writeVersion(write(T0, [ok("england", T0 + P, 210)]));
    await store.writeVersion(write(T0 + 30 * MIN, [ok("england", T0 + P, 215), ok("england", T0 + 2 * P, 190)]));
    await store.writeVersion(write(T0 + 60 * MIN, [ok("england", T0 + P, 220), ok("england", T0 + 2 * P, 190)]));
    const q = { dataset: DS, region: "england", from: T0, to: T0 + 3 * P };

    expect(await store.asOf({ ...q, asOf: T0 - 1 })).toEqual([]); // before we knew anything
    expect(values(await store.asOf({ ...q, asOf: T0 }))).toEqual([210]); // boundary is inclusive
    expect(values(await store.asOf({ ...q, asOf: T0 + 45 * MIN }))).toEqual([215, 190]);
    expect(values(await store.asOf(q))).toEqual([220, 190]); // latest

    const [first] = await store.asOf({ ...q, asOf: T0 + 45 * MIN });
    expect(first).toEqual({
      region: "england",
      validFrom: T0 + P,
      value: 215,
      quality: "ok",
      rawValue: null,
      ingestedAt: T0 + 30 * MIN,
      publishedAt: T0 + 30 * MIN - 20_000,
    });
  });

  it("gives the same as-of answer however many versions arrive later", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200)]));
    const q = { dataset: DS, region: "england", from: T0, to: T0 + P, asOf: T0 + MIN };
    const before = await store.asOf(q);
    for (let i = 1; i <= 5; i++) await store.writeVersion(write(T0 + i * 10 * MIN, [ok("england", T0, 200 + i)]));
    expect(await store.asOf(q)).toEqual(before);
  });

  it("filters by dataset, region and the half-open period range", async () => {
    await store.writeVersion(write(T0, [ok("england", T0 - P, 1), ok("england", T0, 2), ok("england", T0 + P, 3), ok("wales", T0, 9)]));
    await store.writeVersion(write(T0, [ok("england", T0, 99)], { dataset: "other.dataset" }));
    expect(values(await store.asOf({ dataset: DS, region: "england", from: T0, to: T0 + P }))).toEqual([2]);
    expect(values(await store.asOf({ dataset: DS, region: "wales", from: T0 - P, to: T0 + 2 * P }))).toEqual([9]);
    expect(await store.asOf({ dataset: DS, region: "scotland", from: T0, to: T0 + P })).toEqual([]);
  });

  it("stores quality changes as versions and keeps rejected raw values", async () => {
    const missing: Observation = { region: "england", validFrom: T0, value: null, quality: "missing", rawValue: null };
    const rejected: Observation = { region: "england", validFrom: T0, value: null, quality: "rejected", rawValue: "-5" };
    const rejected2: Observation = { ...rejected, rawValue: "-6" };
    expect(await store.writeVersion(write(T0, [missing]))).toBe(1);
    expect(await store.writeVersion(write(T0 + MIN, [missing]))).toBe(0);
    expect(await store.writeVersion(write(T0 + 2 * MIN, [rejected]))).toBe(1);
    expect(await store.writeVersion(write(T0 + 3 * MIN, [rejected2]))).toBe(1); // raw changed
    expect(await store.writeVersion(write(T0 + 4 * MIN, [ok("england", T0, 200)]))).toBe(1);
    const at = (t: number) => store.asOf({ dataset: DS, region: "england", from: T0, to: T0 + P, asOf: t });
    expect((await at(T0 + 2 * MIN))[0]).toMatchObject({ quality: "rejected", rawValue: "-5", value: null });
    expect((await at(T0 + 4 * MIN))[0]).toMatchObject({ quality: "ok", value: 200 });
  });

  it("logs every successful write, including ones that changed nothing", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200)], { dropped: 2 }));
    await store.writeVersion(write(T0 + 10 * MIN, [ok("england", T0, 200)]));
    expect(await store.lastSuccess(DS)).toEqual({
      fetchedAt: T0 + 10 * MIN,
      publishedAt: T0 + 10 * MIN - 20_000,
      ok: true,
      rowsSeen: 1,
      rowsChanged: 0,
      rowsDropped: 0,
      error: null,
    });
    expect(await store.lastSuccess(DS, T0 + 5 * MIN)).toMatchObject({ fetchedAt: T0, rowsChanged: 1, rowsDropped: 2 });
    expect(await store.lastSuccess(DS, T0 - 1)).toBeNull();
    expect(await store.lastSuccess("other.dataset")).toBeNull();
  });

  it("logs failures without counting them as successes", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200)]));
    await store.recordFailure({ dataset: DS, fetchedAt: T0 + MIN, publishedAt: null, error: "x".repeat(2_000) });
    await store.recordFailure({ dataset: DS, fetchedAt: T0 + 2 * MIN, publishedAt: null, error: "" });
    expect((await store.lastSuccess(DS))!.fetchedAt).toBe(T0);
    const r = await sql.query("select ok, error from env_fetch where not ok order by fetched_at");
    expect(r.rows[0].ok).toBe(false);
    expect(r.rows[0].error).toBe(`${"x".repeat(500)}…`); // clipped
    expect(r.rows[1]).toMatchObject({ error: "unknown error" });
  });

  it("drops a source publish time that is later than our own clock", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200)], { publishedAt: T0 + MIN }));
    const [row] = await store.asOf({ dataset: DS, region: "england", from: T0, to: T0 + P });
    expect(row!.publishedAt).toBeNull();
  });

  it("is append-only: no update, delete or truncate", async () => {
    await store.writeVersion(write(T0, [ok("england", T0, 200)]));
    await expect(sql.query("update env_observation set value = 1")).rejects.toThrow(/append-only/);
    await expect(sql.query("delete from env_observation")).rejects.toThrow(/append-only/);
    await expect(sql.query("truncate env_observation")).rejects.toThrow(/append-only/);
  });

  it("rejects rows whose value and quality disagree", async () => {
    const bad = (value: string, quality: string, raw: string) =>
      sql.query(
        `insert into env_observation (dataset, region, valid_from, ingested_at, value, unit, quality, raw_value) values ('d', 'r', now(), now(), ${value}, 'u', '${quality}', ${raw})`,
      );
    await expect(bad("1", "missing", "null")).rejects.toThrow(/check constraint/);
    await expect(bad("null", "ok", "null")).rejects.toThrow(/check constraint/);
    await expect(bad("null", "rejected", "null")).rejects.toThrow(/check constraint/);
    await expect(bad("null", "missing", "'x'")).rejects.toThrow(/check constraint/);
    await expect(bad("null", "unknown", "null")).rejects.toThrow(/check constraint/);
  });

  it("appends a change once when several replicas write the same fetch at the same moment", async () => {
    const replicas = [1, 2, 3, 4].map(() => new PgEnvStore(db.url));
    try {
      await store.writeVersion(write(T0, [ok("england", T0, 200)]));
      const obs = [ok("england", T0, 205), ok("england", T0 + P, 210)];
      // Different ingestedAt per replica, as their clocks and fetches would differ.
      const changed = await Promise.all(replicas.map((s, i) => s.writeVersion(write(T0 + MIN + i, obs))));
      expect(changed.reduce((a, b) => a + b, 0)).toBe(2);
      const n = await sql.query("select count(*)::int as n from env_observation where valid_from >= $1", [new Date(T0)]);
      expect(n.rows[0].n).toBe(3);
    } finally {
      await Promise.all(replicas.map((s) => s.close()));
    }
  });

  it("writes nothing and keeps no fetch log when the transaction fails", async () => {
    // An invalid period start fails after the transaction has begun and taken the lock.
    const broken = write(T0, [ok("england", T0, 200), { region: "england", validFrom: Number.NaN, value: 1, quality: "ok", rawValue: null }]);
    await expect(store.writeVersion(broken)).rejects.toThrow();
    const n = await sql.query("select (select count(*) from env_observation)::int as o, (select count(*) from env_fetch)::int as f");
    expect(n.rows[0]).toEqual({ o: 0, f: 0 });
  });

  it("validates as-of arguments and caps the row count", async () => {
    const q = { dataset: DS, region: "england", from: T0, to: T0 };
    await expect(store.asOf(q)).rejects.toThrow(RangeError);
    await expect(store.asOf({ ...q, to: T0 + P, limit: 0 })).rejects.toThrow(RangeError);
    await expect(store.asOf({ ...q, to: T0 + P, limit: 1.5 })).rejects.toThrow(RangeError);
    const many = Array.from({ length: 5 }, (_, i) => ok("england", T0 + i * P, i));
    await store.writeVersion(write(T0, many));
    expect(await store.asOf({ ...q, to: T0 + 10 * P, limit: 2 })).toHaveLength(2);
    expect(await store.asOf({ ...q, to: T0 + 10 * P, limit: MAX_ROWS * 10 })).toHaveLength(5);
  });
});
