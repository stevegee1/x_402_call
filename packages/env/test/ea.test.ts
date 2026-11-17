import { describe, expect, it } from "vitest";
import { cleanFloodWarnings, EA_FLOOD_WARNINGS, EaClient, ENV_DATASETS, FLOOD_PERIOD_MS, NESO_DATASETS, OBSERVED_AT } from "../src";

const T = Date.parse("2026-11-17T07:09:30Z");
const BUCKET = Date.parse("2026-11-17T07:00:00Z");
// Live shape, 2026-11-17.
const warning = (floodAreaID: unknown, severityLevel: unknown, observed: unknown = T) => ({
  floodAreaID,
  severityLevel,
  severity: "Flood alert",
  timeRaised: "2026-11-16T16:06:17",
  isTidal: true,
  eaAreaName: "Wessex",
  [OBSERVED_AT]: observed,
});

describe("EA flood warnings", () => {
  it("stores each listed area's severity for the 15-minute period it was observed in", () => {
    const r = cleanFloodWarnings([warning("111WATCHXH", 3), warning("033WAF312", 2)]);
    expect(r).toEqual({
      observations: [
        { region: "fa_033waf312", validFrom: BUCKET, value: 2, quality: "ok", rawValue: null },
        { region: "fa_111watchxh", validFrom: BUCKET, value: 3, quality: "ok", rawValue: null },
      ],
      dropped: 0,
      duplicates: 0,
    });
    expect(BUCKET % FLOOD_PERIOD_MS).toBe(0);
  });

  it("keeps the most severe warning when an area is listed twice", () => {
    const r = cleanFloodWarnings([warning("111WATCHXH", 3), warning("111WATCHXH", 1), warning("111WATCHXH", 4)]);
    expect(r.observations).toEqual([{ region: "fa_111watchxh", validFrom: BUCKET, value: 1, quality: "ok", rawValue: null }]);
    expect(r.duplicates).toBe(2);
  });

  it("flags bad severities and drops rows it can't place", () => {
    const r = cleanFloodWarnings([warning("A1B", 7), warning("A2B", "3"), warning("A3B", null), warning("bad id!", 2), warning("A4B", 2, "now"), null, []]);
    expect(r.observations.map((o) => [o.region, o.quality, o.rawValue])).toEqual([
      ["fa_a1b", "rejected", "7"],
      ["fa_a2b", "rejected", "3"],
      ["fa_a3b", "missing", null],
    ]);
    expect(r.dropped).toBe(4);
  });

  it("an empty list is a normal fetch: no warnings in force", () => {
    expect(cleanFloodWarnings([])).toEqual({ observations: [], dropped: 0, duplicates: 0 });
    expect(EA_FLOOD_WARNINGS.emptyIsNormal).toBe(true);
  });

  it("is registered as an EA dataset beside the NESO ones, under an id that never changes", () => {
    expect(EA_FLOOD_WARNINGS).toMatchObject({ id: "ea.flood_warnings", source: "ea", periodMs: 900_000 });
    expect(ENV_DATASETS.map((d) => d.id)).toEqual([...NESO_DATASETS.map((d) => d.id), "ea.flood_warnings"]);
  });
});

describe("EaClient", () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });

  it("reads Last-Modified with a HEAD request, and stamps each record with when it was observed", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const responses = [new Response(null, { status: 200, headers: { "last-modified": "Tue, 17 Nov 2026 07:03:12 GMT" } }), ok({ items: [{ floodAreaID: "X1", severityLevel: 3 }, "junk"] })];
    const c = new EaClient({
      baseUrl: "https://ea.example",
      now: () => T,
      fetchImpl: (async (url: URL, init: RequestInit) => (calls.push({ url: String(url), method: init.method }), responses.shift()!)) as unknown as typeof fetch,
    });
    expect(await c.lastModified("/flood-monitoring/id/floods")).toBe(Date.parse("2026-11-17T07:03:12Z"));
    expect(await c.records("/flood-monitoring/id/floods")).toEqual([{ floodAreaID: "X1", severityLevel: 3, [OBSERVED_AT]: T }, "junk"]);
    expect(calls).toEqual([
      { url: "https://ea.example/flood-monitoring/id/floods", method: "HEAD" },
      { url: "https://ea.example/flood-monitoring/id/floods", method: "GET" },
    ]);
  });

  it("returns null with no Last-Modified, and throws on HTTP errors or a body with no items", async () => {
    const seq = [new Response(null, { status: 200 }), new Response("busy", { status: 503 }), ok({ nope: 1 })];
    const c = new EaClient({ baseUrl: "https://ea.example", fetchImpl: (async () => seq.shift()!) as unknown as typeof fetch });
    expect(await c.lastModified("/x")).toBeNull();
    await expect(c.records("/x")).rejects.toThrow(/HTTP 503/);
    await expect(c.records("/x")).rejects.toThrow(/unexpected response/);
  });
});
