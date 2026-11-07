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

  it("reads the newest records, newest first", async () => {
    const f = fake(ok({ records: [{ datetime: "x" }] }));
    const c = new NesoClient({ baseUrl: "https://api.example", fetchImpl: f.impl });
    expect(await c.records("res-2", 200)).toEqual([{ datetime: "x" }]);
    const u = f.calls[0]!.url;
    expect(u.pathname).toBe("/api/3/action/datastore_search");
    expect(Object.fromEntries(u.searchParams)).toEqual({ resource_id: "res-2", sort: "datetime desc", limit: "200" });
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
      await expect(c.records("r", 1)).rejects.toThrow(err);
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
