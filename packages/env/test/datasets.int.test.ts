import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../apps/gateway/test/store/pg-db";
import type {} from "../../../apps/gateway/test/store/pg-global-setup";
import { type DatasetSpec, EMBEDDED_WIND_SOLAR, GENERATION_MIX, ENV_DATASETS, PgEnvStore, WIND_FORECAST_14D } from "../src";

/**
 * The new datasets end to end through the real store: NESO-shaped rows → the dataset's cleaner →
 * PgEnvStore → point-in-time reads. Whole-run forecasts are the case the store wasn't first built
 * for: each run replaces the resource, so periods that have passed vanish upstream.
 */
const MIN = 60_000;
const T0 = Date.parse("2026-11-16T10:30:00Z");

// Embedded rows for settlement day 2026-11-16 (GMT, so UTC = local): SP n ends at n × 30 min.
const embedded = (sp: number, wind: number, solar = 4000) => ({
  SETTLEMENT_DATE: "2026-11-16T00:00:00",
  SETTLEMENT_PERIOD: sp,
  DATE_GMT: sp === 48 ? "2026-11-17T00:00:00" : "2026-11-16T00:00:00",
  TIME_GMT: sp === 48 ? "00:00" : `${String(Math.floor(sp / 2)).padStart(2, "0")}:${sp % 2 ? "30" : "00"}`,
  EMBEDDED_WIND_FORECAST: wind,
  EMBEDDED_WIND_CAPACITY: 5908,
  EMBEDDED_SOLAR_FORECAST: solar,
  EMBEDDED_SOLAR_CAPACITY: 23963,
});
const spStart = (sp: number) => Date.parse("2026-11-16T00:00:00Z") + (sp - 1) * 30 * MIN;

describe("NESO datasets through the store", () => {
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

  const ingest = async (spec: DatasetSpec, records: unknown[], ingestedAt: number) => {
    const c = spec.clean(records);
    return store.writeVersion({ dataset: spec.id, unit: spec.unit, ingestedAt, publishedAt: ingestedAt - 30_000, observations: c.observations, dropped: c.dropped });
  };

  it("keeps a whole-run forecast's revisions and the periods that later vanish upstream", async () => {
    // Run 1 at 10:30 covers SP 22-24. Run 2 at 11:00 has rolled forward: SP 22 is gone, SP 23 is revised, SP 25 is new.
    expect(await ingest(EMBEDDED_WIND_SOLAR, [embedded(22, 700), embedded(23, 650), embedded(24, 600)], T0)).toBe(12);
    // Only the changed wind value and the four series of the new period are appended; capacities and
    // solar for SP 23-24 are unchanged.
    expect(await ingest(EMBEDDED_WIND_SOLAR, [embedded(23, 640), embedded(24, 600), embedded(25, 580)], T0 + 30 * MIN)).toBe(5);

    const before = await store.asOf({ dataset: EMBEDDED_WIND_SOLAR.id, region: "wind", from: spStart(22), to: spStart(26), asOf: T0 + 10 * MIN });
    expect(before.map((o) => [o.validFrom, o.value])).toEqual([
      [spStart(22), 700],
      [spStart(23), 650],
      [spStart(24), 600],
    ]);
    const now = await store.asOf({ dataset: EMBEDDED_WIND_SOLAR.id, region: "wind", from: spStart(22), to: spStart(26) });
    // SP 22 vanished upstream but its last known forecast stays: absence is not deletion.
    expect(now.map((o) => [o.validFrom, o.value])).toEqual([
      [spStart(22), 700],
      [spStart(23), 640],
      [spStart(24), 600],
      [spStart(25), 580],
    ]);
    expect((await store.revisions(EMBEDDED_WIND_SOLAR.id, "wind", spStart(23))).map((o) => o.value)).toEqual([650, 640]);
    // Capacity is its own series, stored once while it doesn't change.
    expect((await store.revisions(EMBEDDED_WIND_SOLAR.id, "wind_capacity", spStart(24))).map((o) => o.value)).toEqual([5908]);
  });

  it("keeps datasets apart even when they share series names and periods", async () => {
    await ingest(EMBEDDED_WIND_SOLAR, [embedded(22, 700)], T0);
    const transmission = [{ Date: "2026-11-16", Settlement_Period: 22, Datetime: "2026-11-16T10:30:00", Wind_Forecast: 9000, Capacity: 25564, ForecastDateTime: "2026-11-16T10:00:00" }];
    expect(await ingest(WIND_FORECAST_14D, transmission, T0)).toBe(2);
    const read = async (spec: DatasetSpec) => (await store.asOf({ dataset: spec.id, region: "wind", from: spStart(22), to: spStart(23) })).map((o) => o.value);
    expect(await read(EMBEDDED_WIND_SOLAR)).toEqual([700]);
    expect(await read(WIND_FORECAST_14D)).toEqual([9000]);
    const units = await sql.query("select dataset, unit, count(*)::int as n from env_observation group by 1, 2 order by 1");
    expect(units.rows).toEqual([
      { dataset: "neso.embedded_wind_solar_forecast", unit: "MW", n: 4 },
      { dataset: "neso.wind_forecast_14d", unit: "MW", n: 2 },
    ]);
  });

  it("notifies listeners with the dataset that changed", async () => {
    const seen: string[] = [];
    const stop = store.listen({ onNotify: (d) => seen.push(d), onReconnect: () => {}, onError: () => {} });
    await new Promise((r) => setTimeout(r, 300)); // let LISTEN register
    await ingest(GENERATION_MIX, [{ DATETIME: "2026-11-04T23:30:00", GAS: 9937, WIND: 9204 }], T0);
    await ingest(EMBEDDED_WIND_SOLAR, [embedded(22, 700)], T0);
    await ingest(EMBEDDED_WIND_SOLAR, [embedded(22, 700)], T0 + MIN); // no change: no notification
    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    await stop();
    expect(seen).toEqual(["neso.generation_mix", "neso.embedded_wind_solar_forecast"]);
  });

  it("stores every registered dataset's empty fetch as a logged no-op", async () => {
    for (const spec of ENV_DATASETS) expect(await ingest(spec, [], T0)).toBe(0);
    const n = await sql.query("select count(distinct dataset)::int as n from env_fetch where ok and rows_seen = 0");
    expect(n.rows[0].n).toBe(ENV_DATASETS.length);
  });
});
