import { describe, expect, it } from "vitest";
import { EnvCache, EnvFollower, type CacheSource, type ChangeRow, type FetchRecord, type FollowerStore } from "../src";

const DS = "neso.carbon_intensity";
const NOW = Date.parse("2026-11-07T15:00:00Z");

class Fake implements CacheSource, FollowerStore {
  rows: ChangeRow[] = [];
  lastOk: number | null = null;
  failRefresh = false;
  failStatus = false;
  handlers?: { onNotify: (d: string) => void; onReconnect: () => void; onError: (e: unknown) => void };
  stopped = false;

  async snapshot() {
    if (this.failRefresh) throw new Error("db down");
    return { rows: [...this.rows], maxSeq: this.rows.length };
  }
  async changesSince(_d: string, after: number) {
    if (this.failRefresh) throw new Error("db down");
    return this.rows.filter((r) => r.seq > after);
  }
  async lastSuccess(): Promise<FetchRecord | null> {
    if (this.failStatus) throw new Error("status down");
    return this.lastOk === null ? null : { fetchedAt: this.lastOk, publishedAt: null, ok: true, rowsSeen: 1, rowsChanged: 1, rowsDropped: 0, error: null };
  }
  listen(h: NonNullable<Fake["handlers"]>) {
    this.handlers = h;
    return async () => {
      this.stopped = true;
    };
  }
  add(value: number) {
    this.rows.push({ seq: this.rows.length + 1, region: "england", validFrom: NOW, value, quality: "ok", rawValue: null, ingestedAt: NOW + this.rows.length, publishedAt: null });
  }
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function setup() {
  const src = new Fake();
  const cache = new EnvCache(src, { dataset: DS, regions: ["england"], windowMs: 86_400_000 }, () => NOW);
  const warnings: string[] = [];
  const f = new EnvFollower(src, cache, { warn: (_o, m) => warnings.push(m) }, 60_000);
  return { src, cache, f, warnings };
}

describe("EnvFollower", () => {
  it("loads the cache and reads ingest status before start() returns", async () => {
    const { src, cache, f } = setup();
    src.add(1);
    src.lastOk = NOW - 1_000;
    await f.start();
    expect(cache.ready).toBe(true);
    expect(cache.position).toBe(1);
    expect(f.ingestLastSuccessAt).toBe(NOW - 1_000);
    await f.stop();
    expect(src.stopped).toBe(true);
  });

  it("on a notification, updates both the cache and the ingest status before telling listeners", async () => {
    // Regression: a notification used to refresh only the cache, so a reader judging freshness saw
    // new rows with a stale ingest status and stayed "stale" until the next poll.
    const { src, f } = setup();
    await f.start();
    const seen: Array<[number | null, number]> = [];
    f.onUpdate(() => seen.push([f.ingestLastSuccessAt, f.cache.position]));
    src.add(1);
    src.lastOk = NOW;
    src.handlers!.onNotify(DS);
    await settle();
    expect(seen).toEqual([[NOW, 1]]);
    await f.stop();
  });

  it("ignores notifications for other datasets", async () => {
    const { src, f } = setup();
    await f.start();
    let calls = 0;
    f.onUpdate(() => calls++);
    src.add(1);
    src.handlers!.onNotify("other.dataset");
    await settle();
    expect(calls).toBe(0);
    expect(f.cache.position).toBe(0);
    await f.stop();
  });

  it("catches up on reconnect, and tells listeners even when nothing changed", async () => {
    const { src, f } = setup();
    await f.start();
    let calls = 0;
    f.onUpdate(() => calls++);
    src.handlers!.onReconnect();
    await settle();
    expect(calls).toBe(1); // ingest status may have changed with no new rows
    await f.stop();
  });

  it("never throws: store failures are counted and logged, and listeners still run", async () => {
    const { src, f, warnings } = setup();
    src.failRefresh = true;
    src.failStatus = true;
    let calls = 0;
    f.onUpdate(() => calls++);
    await f.start();
    expect(f.failures).toBe(1);
    expect(f.cache.ready).toBe(false);
    expect(warnings).toEqual(["could not read ingest status", "env cache refresh failed"]); // status is read before the cache
    expect(calls).toBe(1);
    src.failRefresh = false;
    src.failStatus = false;
    await f.tick();
    expect(f.failures).toBe(0);
    expect(f.cache.ready).toBe(true);
    await f.stop();
  });

  it("isolates a failing listener", async () => {
    const { f, warnings } = setup();
    let second = 0;
    f.onUpdate(() => {
      throw new Error("boom");
    });
    f.onUpdate(() => second++);
    await f.start();
    expect(second).toBe(1);
    expect(warnings).toContain("env follower listener failed");
    await f.stop();
  });

  it("logs connection errors from the listener", async () => {
    const { src, f, warnings } = setup();
    await f.start();
    src.handlers!.onError(new Error("ECONNRESET"));
    expect(warnings).toContain("env notification connection error");
    await f.stop();
  });
});

describe("EnvFollower over several datasets, one connection", () => {
  class MultiFake implements CacheSource, FollowerStore {
    rows = new Map<string, ChangeRow[]>();
    lastOk = new Map<string, number>();
    listens = 0;
    handlers?: { onNotify: (d: string) => void; onReconnect: () => void; onError: (e: unknown) => void };
    reads: string[] = [];
    async snapshot(d: string) {
      this.reads.push(d);
      const rows = this.rows.get(d) ?? [];
      return { rows: [...rows], maxSeq: rows.length };
    }
    async changesSince(d: string, after: number) {
      this.reads.push(d);
      return (this.rows.get(d) ?? []).filter((r) => r.seq > after);
    }
    async lastSuccess(d: string): Promise<FetchRecord | null> {
      const t = this.lastOk.get(d);
      return t === undefined ? null : { fetchedAt: t, publishedAt: null, ok: true, rowsSeen: 1, rowsChanged: 1, rowsDropped: 0, error: null };
    }
    listen(h: NonNullable<MultiFake["handlers"]>) {
      this.listens++;
      this.handlers = h;
      return async () => {};
    }
    add(d: string, region: string) {
      const list = this.rows.get(d) ?? [];
      list.push({ seq: list.length + 1, region, validFrom: NOW, value: 1, quality: "ok", rawValue: null, ingestedAt: NOW + list.length, publishedAt: null });
      this.rows.set(d, list);
    }
  }
  const A = "neso.carbon_intensity";
  const B = "elexon.system_prices";
  function setup() {
    const src = new MultiFake();
    const a = new EnvCache(src, { dataset: A, regions: ["england"], windowMs: 86_400_000 }, () => NOW);
    const b = new EnvCache(src, { dataset: B, regions: ["ssp"], windowMs: 86_400_000 }, () => NOW);
    const f = new EnvFollower(src, [a, b], { warn: () => {} }, 60_000);
    return { src, a, b, f };
  }

  it("loads every cache and each dataset's own ingest status, on one listen connection", async () => {
    const { src, a, b, f } = setup();
    src.add(A, "england");
    src.add(B, "ssp");
    src.lastOk.set(A, NOW - 1_000);
    src.lastOk.set(B, NOW - 9_000);
    await f.start();
    expect([a.ready, b.ready, a.position, b.position]).toEqual([true, true, 1, 1]);
    expect([f.ingestLastSuccess(A), f.ingestLastSuccess(B), f.ingestLastSuccessAt]).toEqual([NOW - 1_000, NOW - 9_000, NOW - 1_000]);
    expect(src.listens).toBe(1);
    expect(f.cacheFor(B)).toBe(b);
    await f.stop();
  });

  it("a notification refreshes only its dataset, and listeners hear which one", async () => {
    const { src, a, b, f } = setup();
    await f.start();
    const heard: string[] = [];
    f.onUpdate((d) => heard.push(d));
    src.reads = [];
    src.add(B, "ssp");
    src.handlers!.onNotify(B);
    await settle();
    expect(heard).toEqual([B]);
    expect(src.reads.every((d) => d === B)).toBe(true);
    expect([a.position, b.position]).toEqual([0, 1]);
    await f.stop();
  });

  it("a reconnect refreshes every dataset", async () => {
    const { src, f } = setup();
    await f.start();
    const heard: string[] = [];
    f.onUpdate((d) => heard.push(d));
    src.handlers!.onReconnect();
    await settle();
    expect(heard.sort()).toEqual([B, A].sort());
    await f.stop();
  });

  it("refuses two caches for one dataset (they would drift apart)", () => {
    const src = new MultiFake();
    const a1 = new EnvCache(src, { dataset: A, regions: ["england"], windowMs: 1 });
    const a2 = new EnvCache(src, { dataset: A, regions: ["wales"], windowMs: 1 });
    expect(() => new EnvFollower(src, [a1, a2], { warn: () => {} })).toThrow(/two caches for dataset/);
    expect(() => new EnvFollower(src, [], { warn: () => {} })).toThrow(/at least one cache/);
  });
});
