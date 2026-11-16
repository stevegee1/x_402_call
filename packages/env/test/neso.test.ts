import { describe, expect, it } from "vitest";
import { NesoClient, parseCkanTimestamp } from "../src";

type Call = { url: URL; init: RequestInit };

function fake(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });

describe("parseCkanTimestamp", () => {
  it("reads CKAN's naive timestamps as UTC, to the millisecond", () => {
    expect(parseCkanTimestamp("2026-11-07T14:10:28.970501")).toBe(Date.parse("2026-11-07T14:10:28.970Z"));
    expect(parseCkanTimestamp("2026-11-07T14:10:28")).toBe(Date.parse("2026-11-07T14:10:28Z"));
  });

  it("returns null for anything else", () => {
    for (const v of [null, undefined, 1, "", "2026-11-07", "2026-11-07T14:10:28Z", "2026-11-07T14:10:28+01:00", "garbage", "2026-02-30T00:00:00x"]) {
      expect(parseCkanTimestamp(v)).toBeNull();
    }
  });
});

describe("NesoClient", () => {
  it("asks resource_show for the resource and reads last_modified", async () => {
    const f = fake(ok({ last_modified: "2026-11-07T14:10:28.970501", metadata_modified: "2026-11-07T14:10:28.144198" }));
    const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: f.impl, userAgent: "ua-test" });
    expect(await c.lastModified("res-1")).toBe(Date.parse("2026-11-07T14:10:28.970Z"));
    expect(f.calls[0]!.url.toString()).toBe("https://api.example/api/3/action/resource_show?id=res-1");
    expect(new Headers(f.calls[0]!.init.headers).get("user-agent")).toBe("ua-test");
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to metadata_modified, then to null", async () => {
    const f = fake(ok({ last_modified: null, metadata_modified: "2026-11-07T14:10:28" }), ok({}));
    const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: f.impl });
    expect(await c.lastModified("r")).toBe(Date.parse("2026-11-07T14:10:28Z"));
    expect(await c.lastModified("r")).toBeNull();
  });

  it("reads records in the dataset's sort order", async () => {
    const f = fake(ok({ records: [{ datetime: "x" }] }), ok({ records: [] }));
    const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: f.impl });
    expect(await c.records("res-2", 200, "datetime desc")).toEqual([{ datetime: "x" }]);
    const u = f.calls[0]!.url;
    expect(u.pathname).toBe("/api/3/action/datastore_search");
    expect(Object.fromEntries(u.searchParams)).toEqual({ resource_id: "res-2", sort: "datetime desc", limit: "200" });
    await c.records("res-3", 2000, "SETTLEMENT_DATE desc, SETTLEMENT_PERIOD desc");
    expect(f.calls[1]!.url.searchParams.get("sort")).toBe("SETTLEMENT_DATE desc, SETTLEMENT_PERIOD desc");
  });

  /** A client on a fake clock: sleepers wake in time order, and waking moves the clock to their wake time. */
  function throttled(opts: { minIntervalMs?: number; priorityResourceIds?: string[]; early?: number } = {}) {
    const clock = { now: 1_000_000 };
    const sleepers: Array<{ at: number; wake: () => void }> = [];
    const sleeps: number[] = [];
    const starts: Array<[number, string]> = [];
    const impl = (async (url: URL) => {
      starts.push([clock.now, url.searchParams.get("id") ?? ""]);
      return ok({ last_modified: "2026-11-07T14:10:28" });
    }) as unknown as typeof fetch;
    const c = new NesoClient({
      baseUrl: "https://api.example",
      fetchImpl: impl,
      minIntervalMs: opts.minIntervalMs ?? 1_000,
      priorityResourceIds: opts.priorityResourceIds,
      now: () => clock.now,
      // `early` makes every timer fire up to that many ms early (but after at least 1 ms), as Node timers sometimes do.
      sleep: (ms) => (sleeps.push(ms), new Promise<void>((wake) => sleepers.push({ at: clock.now + Math.max(ms - (opts.early ?? 0), 1), wake }))),
    });
    const flush = () => new Promise((r) => setImmediate(r));
    const drain = async () => {
      await flush();
      while (sleepers.length > 0) {
        sleepers.sort((x, y) => x.at - y.at);
        const s = sleepers.shift()!;
        clock.now = Math.max(clock.now, s.at);
        s.wake();
        await flush();
      }
    };
    return { c, clock, starts, sleeps, sleepers, drain };
  }

  it("spaces requests across all callers by minIntervalMs, so many datasets never exceed the rate", async () => {
    const t = throttled();
    const all = Promise.all(Array.from({ length: 6 }, (_, i) => t.c.lastModified(`r${i}`)));
    await t.drain();
    await all;
    expect(t.starts.map(([at]) => at)).toEqual([0, 1, 2, 3, 4, 5].map((i) => 1_000_000 + i * 1_000));
    expect(t.starts.map(([, id]) => id)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]); // FIFO
    // After a quiet spell, the next request goes at once.
    t.clock.now += 60_000;
    const before = t.sleeps.length;
    await t.c.lastModified("r");
    expect(t.sleeps.length).toBe(before);
  });

  it("never starts two requests closer than the gap, even when timers fire early", async () => {
    const t = throttled({ early: 3 });
    const all = Promise.all(Array.from({ length: 5 }, (_, i) => t.c.lastModified(`r${i}`)));
    await t.drain();
    await all;
    const at = t.starts.map(([a]) => a);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(1_000);
  });

  it("holds the gap on real timers too (no fake clock)", async () => {
    const at: number[] = [];
    const c = new NesoClient({ baseUrl: "https://api.example", minIntervalMs: 40, fetchImpl: (async () => (at.push(performance.now()), ok({}))) as unknown as typeof fetch });
    await Promise.all(Array.from({ length: 8 }, (_, i) => c.lastModified(`r${i}`)));
    // Releases are exactly 40 ms apart; the send itself follows release by a little work, which
    // jitters by under a millisecond (measured 39.96-41.5 ms). The 1,100 ms production gap leaves a
    // 100 ms margin over NESO's 1 s for exactly this.
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(35);
  });

  it("lets priority resources go ahead of everything already waiting", async () => {
    const t = throttled({ priorityResourceIds: ["paid"] });
    const all = Promise.all(["a", "b", "c", "paid"].map((id) => t.c.lastModified(id)));
    await t.drain();
    await all;
    // "a" was already started; the paid request jumps the two still waiting.
    expect(t.starts.map(([, id]) => id)).toEqual(["a", "paid", "b", "c"]);
  });

  it("starts the next request within one gap after the clock steps back an hour", async () => {
    const t = throttled();
    await t.c.lastModified("a");
    t.clock.now -= 3_600_000; // the clock steps back an hour
    const stepped = t.clock.now;
    const p = t.c.lastModified("b");
    await t.drain();
    await p;
    expect(t.starts[1]![0] - stepped).toBeLessThanOrEqual(1_000);
    expect(t.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_000);
  });

  it("keeps serving after the injected sleep throws, instead of hanging every later request", async () => {
    let fail = true;
    const c = new NesoClient({
      baseUrl: "https://api.example",
      minIntervalMs: 5,
      fetchImpl: (async () => ok({})) as unknown as typeof fetch,
      sleep: async (ms) => {
        if (fail) {
          fail = false;
          throw new Error("boom");
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    const all = await Promise.all(["a", "b", "c"].map((id) => c.lastModified(id)));
    expect(all).toHaveLength(3);
    expect(await c.lastModified("d")).toBeNull();
  });

  it("keeps the queue moving after a request fails", async () => {
    let calls = 0;
    const c = new NesoClient({
      baseUrl: "https://api.example",
      minIntervalMs: 1,
      fetchImpl: (async () => (++calls === 1 ? Promise.reject(new Error("ECONNRESET")) : ok({})) ) as unknown as typeof fetch,
    });
    const [a, b] = await Promise.allSettled([c.lastModified("x"), c.lastModified("y")]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
  });

  it("does not space requests by default", async () => {
    const f = fake(ok({}), ok({}));
    const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: f.impl, sleep: async () => expect.fail("must not sleep") });
    await c.lastModified("a");
    await c.lastModified("b");
    expect(f.calls).toHaveLength(2);
  });

  it("throws on HTTP errors, unsuccessful or malformed bodies, and network failures", async () => {
    const cases: Array<[Response | Error, RegExp]> = [
      [new Response("busy", { status: 503 }), /HTTP 503/],
      [new Response(JSON.stringify({ success: false, error: {} })), /unexpected response/],
      [new Response(JSON.stringify({ success: true })), /unexpected response/],
      [new Response("not json"), /JSON|Unexpected/],
      [ok({ records: "nope" }), /unexpected response/],
      [new Error("ECONNRESET"), /ECONNRESET/],
    ];
    for (const [resp, err] of cases) {
      const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: fake(resp).impl });
      await expect(c.records("r", 1, "datetime desc")).rejects.toThrow(err);
    }
    const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: fake(ok(null)).impl });
    await expect(c.lastModified("r")).rejects.toThrow(/unexpected response/);
  });

  it("aborts a request that outlives the timeout", async () => {
    const hang = (async (_u: URL, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: hang, timeoutMs: 20 });
    await expect(c.lastModified("r")).rejects.toThrow(/timeout|aborted/i);
  });
});
