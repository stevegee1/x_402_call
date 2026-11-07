import { EnvCache, type CacheSource, type ChangeRow } from "@mx/env";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config";
import { STORE_LIMITS, StoreGridSource } from "../../../src/products/grid/store-source";
import { PAY_TO as PAY } from "../../helpers";
import { CUR, T0 } from "./fixtures";

const P = 30 * 60_000;

function source(rows: ChangeRow[]): CacheSource {
  return {
    snapshot: async (_d, regions, min) => ({ rows: rows.filter((r) => regions.includes(r.region) && r.validFrom >= min), maxSeq: rows.length }),
    changesSince: async () => [],
  };
}
const row = (seq: number, region: string, validFrom: number, value: number | null, quality: ChangeRow["quality"] = "ok"): ChangeRow => ({
  seq,
  region,
  validFrom,
  value,
  quality,
  rawValue: quality === "rejected" ? "-1" : null,
  ingestedAt: T0 - 60_000,
  publishedAt: null,
});

async function setup(rows: ChangeRow[], health: { refresh?: number | null; ingest?: number | null } = {}) {
  const cache = new EnvCache(source(rows), { dataset: "d", regions: ["england", "scotland", "wales"], windowMs: 7 * 86_400_000 }, () => T0);
  await cache.refresh();
  const refreshAt = "refresh" in health ? health.refresh! : T0;
  const ingestAt = "ingest" in health ? health.ingest! : T0;
  return new StoreGridSource(cache, { lastRefreshAt: () => refreshAt, ingestLastSuccessAt: () => ingestAt }, () => T0);
}

describe("StoreGridSource", () => {
  it("merges the regions into half-hours and treats missing or rejected values as gaps", async () => {
    const s = await setup([
      row(1, "england", CUR + P, 190),
      row(2, "england", CUR, 200),
      row(3, "scotland", CUR, null, "missing"),
      row(4, "wales", CUR, null, "rejected"),
    ]);
    expect(await s.fetch()).toEqual([
      { start: CUR, values: { england: 200, scotland: null, wales: null } },
      { start: CUR + P, values: { england: 190, scotland: null, wales: null } },
    ]);
  });

  it("leaves out periods more than two days old", async () => {
    const s = await setup([row(1, "england", CUR - 3 * 86_400_000, 1), row(2, "england", CUR, 2)]);
    expect((await s.fetch()).map((h) => h.start)).toEqual([CUR]);
  });

  it("fails (so the feed goes stale, never charging) when the cache isn't loaded", async () => {
    const cache = new EnvCache(source([]), { dataset: "d", regions: ["england"], windowMs: 1 }, () => T0);
    const s = new StoreGridSource(cache, { lastRefreshAt: () => T0, ingestLastSuccessAt: () => T0 }, () => T0);
    await expect(s.fetch()).rejects.toThrow(/not loaded/);
  });

  it("fails when the cache has stopped refreshing", async () => {
    await expect((await setup([], { refresh: null })).fetch()).rejects.toThrow(/not refreshing/);
    await expect((await setup([], { refresh: T0 - STORE_LIMITS.maxRefreshAgeMs - 1 })).fetch()).rejects.toThrow(/not refreshing/);
    await expect((await setup([], { refresh: T0 - STORE_LIMITS.maxRefreshAgeMs })).fetch()).resolves.toEqual([]);
  });

  it("fails when ingest has not fetched recently", async () => {
    await expect((await setup([], { ingest: null })).fetch()).rejects.toThrow(/ingest-env/);
    await expect((await setup([], { ingest: T0 - STORE_LIMITS.maxIngestAgeMs - 1 })).fetch()).rejects.toThrow(/ingest-env/);
    await expect((await setup([], { ingest: T0 - STORE_LIMITS.maxIngestAgeMs })).fetch()).resolves.toEqual([]);
  });
});

describe("GRID_SOURCE config", () => {
  const base = { PAY_TO: PAY, FACILITATOR: "url", FACILITATOR_URL: "http://f.test" };
  it("defaults to neso", () => {
    expect(loadConfig(base).GRID_SOURCE).toBe("neso");
    expect(loadConfig(base).GRID_HISTORY_MEMORY_DAYS).toBe(7);
  });
  it("store needs a database", () => {
    expect(() => loadConfig({ ...base, GRID_ENABLED: "true", GRID_SOURCE: "store" })).toThrow(/GRID_SOURCE: store needs DATABASE_URL/);
    expect(loadConfig({ ...base, GRID_ENABLED: "true", GRID_SOURCE: "store", DATABASE_URL: "postgres://x@y/z" }).GRID_SOURCE).toBe("store");
  });
  it("bounds the memory window", () => {
    expect(() => loadConfig({ ...base, GRID_HISTORY_MEMORY_DAYS: "0" })).toThrow(/GRID_HISTORY_MEMORY_DAYS/);
    expect(() => loadConfig({ ...base, GRID_HISTORY_MEMORY_DAYS: "32" })).toThrow(/GRID_HISTORY_MEMORY_DAYS/);
  });
});
