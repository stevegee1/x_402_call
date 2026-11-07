import { CARBON_INTENSITY, type FetchFailure, type VersionWrite } from "@mx/env";
import { Metrics } from "@mx/shared";
import { describe, expect, it } from "vitest";
import { Poller, type PollerOptions, type PollerSource, type PollerStore } from "../src/poller";

const OPTS: PollerOptions = { checkMs: 30_000, maxFetchIntervalMs: 600_000, maxBackoffMs: 300_000 };
const T0 = Date.parse("2026-11-07T14:10:00Z");
const PUB = Date.parse("2026-11-07T14:09:40Z");
const ROWS = [{ datetime: "2026-11-07T14:00:00", England: 200, Scotland: 30, Wales: 300 }];

function harness(opts: Partial<{ modified: Array<number | null | Error>; records: Array<unknown[] | Error>; write: Array<number | Error>; failure: Error }> = {}) {
  let now = T0;
  const modified = opts.modified ?? [];
  const records = opts.records ?? [];
  const writeResults = opts.write ?? [];
  const writes: VersionWrite[] = [];
  const failures: FetchFailure[] = [];
  const calls = { lastModified: 0, records: 0 };
  const take = <T>(q: Array<T | Error>, def: T): T => {
    const v = q.length > 1 ? q.shift()! : q.length === 1 ? q[0]! : def; // the last entry repeats
    if (v instanceof Error) throw v;
    return v;
  };
  const source: PollerSource = {
    lastModified: async (id) => {
      expect(id).toBe(CARBON_INTENSITY.resourceId);
      calls.lastModified++;
      return take(modified, PUB);
    },
    records: async (id, limit) => {
      expect([id, limit]).toEqual([CARBON_INTENSITY.resourceId, CARBON_INTENSITY.fetchLimit]);
      calls.records++;
      return take(records, ROWS);
    },
  };
  const store: PollerStore = {
    writeVersion: async (w) => {
      const r = take(writeResults, 3);
      writes.push(w);
      return r;
    },
    recordFailure: async (f) => {
      if (opts.failure) throw opts.failure;
      failures.push(f);
    },
  };
  const metrics = new Metrics();
  const logs: Array<[string, object, string]> = [];
  const log = { info: (o: object, m: string) => logs.push(["info", o, m]), warn: (o: object, m: string) => logs.push(["warn", o, m]) };
  const poller = new Poller(CARBON_INTENSITY, source, store, metrics, log, OPTS, () => now, () => 0.5);
  return { poller, writes, failures, calls, metrics, logs, advance: (ms: number) => (now += ms) };
}

const L = { dataset: "neso.carbon_intensity" };

describe("Poller", () => {
  it("fetches on the first tick and writes the cleaned version with both timestamps", async () => {
    const h = harness();
    expect(await h.poller.tick()).toBe("fetched");
    expect(h.writes).toHaveLength(1);
    const w = h.writes[0]!;
    expect(w).toMatchObject({ dataset: "neso.carbon_intensity", unit: "gCO2/kWh", ingestedAt: T0, publishedAt: PUB, dropped: 0 });
    expect(w.observations.map((o) => [o.region, o.value])).toEqual([
      ["england", 200],
      ["scotland", 30],
      ["wales", 300],
    ]);
    expect(h.poller.status).toMatchObject({ lastSuccessAt: T0, lastPublishedAt: PUB, lastChanged: 3, consecutiveFailures: 0, lastError: null });
    expect(h.metrics.get("env_checks_total", { ...L, result: "fetched" })).toBe(1);
    expect(h.metrics.get("env_rows_changed_total", L)).toBe(3);
    expect(h.metrics.get("env_last_success_timestamp_seconds", L)).toBe(T0 / 1000);
    // Published before we started watching: not our latency, so not reported.
    expect(h.metrics.get("env_publish_to_ingest_seconds", L)).toBe(0);
  });

  it("reports publish-to-ingest latency for a publish seen while watching", async () => {
    const h = harness({ modified: [PUB, PUB + 1_800_000] });
    await h.poller.tick();
    h.advance(1_800_000 + 15_000); // now = T0 + 30 min 15 s; the new publish was at PUB + 30 min
    await h.poller.tick();
    expect(h.metrics.get("env_publish_to_ingest_seconds", L)).toBe(35);
  });

  it("only checks metadata while the source's publish time is unchanged", async () => {
    const h = harness();
    await h.poller.tick();
    h.advance(30_000);
    expect(await h.poller.tick()).toBe("unchanged");
    h.advance(30_000);
    expect(await h.poller.tick()).toBe("unchanged");
    expect(h.calls).toEqual({ lastModified: 3, records: 1 });
    expect(h.metrics.get("env_checks_total", { ...L, result: "unchanged" })).toBe(2);
  });

  it("fetches as soon as the publish time moves", async () => {
    const h = harness({ modified: [PUB, PUB, PUB + 1_800_000] });
    await h.poller.tick();
    h.advance(30_000);
    await h.poller.tick();
    h.advance(30_000);
    expect(await h.poller.tick()).toBe("fetched");
    expect(h.writes.map((w) => w.publishedAt)).toEqual([PUB, PUB + 1_800_000]);
  });

  it("fetches anyway once the last fetch is older than the maximum interval", async () => {
    const h = harness();
    await h.poller.tick();
    h.advance(599_999);
    expect(await h.poller.tick()).toBe("unchanged");
    h.advance(1);
    expect(await h.poller.tick()).toBe("fetched");
  });

  it("fetches every tick when the source gives no publish time", async () => {
    const h = harness({ modified: [null] });
    await h.poller.tick();
    h.advance(30_000);
    expect(await h.poller.tick()).toBe("fetched");
    expect(h.writes.map((w) => w.publishedAt)).toEqual([null, null]);
    expect(h.metrics.get("env_publish_to_ingest_seconds", L)).toBe(0); // unknown: never reported
  });

  it("does not report latency for a forced fetch when the publish time didn't move", async () => {
    const h = harness();
    await h.poller.tick();
    h.advance(600_000);
    expect(await h.poller.tick()).toBe("fetched");
    expect(h.metrics.get("env_publish_to_ingest_seconds", L)).toBe(0);
  });

  it("retries a fetch whose write failed, even though the publish time didn't move", async () => {
    const h = harness({ write: [new Error("db down"), 3] });
    expect(await h.poller.tick()).toBe("failed");
    expect(h.failures).toEqual([{ dataset: "neso.carbon_intensity", fetchedAt: T0, publishedAt: PUB, error: "db down" }]);
    h.advance(30_000);
    expect(await h.poller.tick()).toBe("fetched");
    expect(h.calls.records).toBe(2);
  });

  it("logs metadata and record failures, counts them, and recovers", async () => {
    const h = harness({ modified: [new Error("HTTP 503"), PUB], records: [new Error("timeout"), ROWS] });
    expect(await h.poller.tick()).toBe("failed");
    expect(h.failures[0]).toMatchObject({ publishedAt: null, error: "HTTP 503" });
    expect(await h.poller.tick()).toBe("failed");
    expect(h.failures[1]).toMatchObject({ publishedAt: PUB, error: "timeout" });
    expect(h.poller.status).toMatchObject({ consecutiveFailures: 2, lastError: "timeout" });
    expect(h.metrics.get("env_consecutive_failures", L)).toBe(2);
    expect(await h.poller.tick()).toBe("fetched");
    expect(h.poller.status).toMatchObject({ consecutiveFailures: 0, lastError: null });
    expect(h.metrics.get("env_checks_total", { ...L, result: "failed" })).toBe(2);
  });

  it("never throws, even when the failure can't be logged", async () => {
    const h = harness({ modified: [new Error("down")], failure: new Error("db also down") });
    expect(await h.poller.tick()).toBe("failed");
    expect(h.logs.some(([lvl, , m]) => lvl === "warn" && m === "could not log the failed fetch")).toBe(true);
  });

  it("reports flagged and dropped rows from cleaning", async () => {
    const h = harness({
      records: [[{ datetime: "2026-11-07T14:00:00", England: null, Scotland: -1, Wales: 300 }, { datetime: "bad" }, { datetime: "2026-11-07T14:00:00", England: null, Scotland: -1, Wales: 300 }]],
    });
    await h.poller.tick();
    expect(h.writes[0]!.dropped).toBe(1);
    expect(h.metrics.get("env_rows_flagged", { ...L, quality: "missing" })).toBe(1);
    expect(h.metrics.get("env_rows_flagged", { ...L, quality: "rejected" })).toBe(1);
    expect(h.metrics.get("env_rows_dropped_total", L)).toBe(1);
    expect(h.metrics.get("env_rows_duplicate_total", L)).toBe(1);
    expect(h.logs.some(([lvl, , m]) => lvl === "warn" && m === "source rows needed cleaning")).toBe(true);
  });

  it("waits the check interval normally and backs off with a cap after failures", async () => {
    const h = harness({ modified: [new Error("down")] });
    expect(h.poller.nextDelay()).toBe(30_000);
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      await h.poller.tick();
      delays.push(h.poller.nextDelay());
    }
    // random() = 0.5: half of min(cap, check × 2^failures), never below the check interval.
    expect(delays).toEqual([30_000, 60_000, 120_000, 150_000, 150_000, 150_000, 150_000, 150_000]);
  });

  it("stop() waits for a tick in flight and prevents the next one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness();
    const slow = new Poller(
      CARBON_INTENSITY,
      { lastModified: async () => (await gate, PUB), records: async () => ROWS },
      { writeVersion: async () => 1, recordFailure: async () => {} },
      new Metrics(),
      { info: () => {}, warn: () => {} },
      { ...OPTS, checkMs: 5 },
    );
    slow.start();
    let stopped = false;
    const stopping = slow.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // still waiting for the tick
    release();
    await stopping;
    expect(slow.status.lastSuccessAt).not.toBeNull(); // the in-flight tick completed its write
    const before = slow.status.lastCheckAt;
    await new Promise((r) => setTimeout(r, 30));
    expect(slow.status.lastCheckAt).toBe(before); // no further ticks
    expect(h.calls.lastModified).toBe(0);
  });
});
