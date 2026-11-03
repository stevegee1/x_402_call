import { describe, expect, it } from "vitest";
import { NESO_COUNTRY_RESOURCE_ID, NesoGridSource, parseRecords } from "../../../src/products/grid/source";
import { CUR, periods, record } from "./fixtures";

describe("NESO records", () => {
  it("parses naive timestamps as UTC, sorts ascending and de-duplicates", () => {
    const p = periods(0, 2);
    const recs = [p[2], p[0], p[1], p[0], p[3]].map((x) => record(x!));
    const out = parseRecords(recs);
    expect(out.map((x) => x.start)).toEqual(p.slice(0, 4).map((x) => x.start));
    expect(out[0]).toEqual({ start: CUR, values: { england: 200, scotland: 20, wales: 300 } });
  });

  it("accepts numeric strings and turns missing or implausible values into null", () => {
    const [p] = parseRecords([{ datetime: "2026-11-03T17:30:00", England: "185", Scotland: null, Wales: -4 }, { datetime: "2026-11-03T18:00:00", England: 9_999, Scotland: "x", Wales: 0 }]);
    expect(p!.values).toEqual({ england: 185, scotland: null, wales: null });
  });

  it.each([
    [{ datetime: "2026-11-03 17:30" }],
    [{ datetime: "2026-11-03T17:15:00", England: 1 }], // not on a half-hour boundary
    [{ datetime: 123 }],
    [null],
    ["row"],
  ])("drops malformed record %j", (r) => {
    expect(parseRecords([r])).toEqual([]);
  });

  it("queries the country resource, newest first, with a bounded limit", async () => {
    let seen: URL | undefined;
    const src = new NesoGridSource("https://neso.example", (async (u: URL) => {
      seen = u;
      return new Response(JSON.stringify({ success: true, result: { records: [record(periods(0, 1)[0]!)] } }));
    }) as typeof fetch);
    const out = await src.fetch();
    expect(out).toHaveLength(1);
    expect(seen!.origin + seen!.pathname).toBe("https://neso.example/api/3/action/datastore_search");
    expect(Object.fromEntries(seen!.searchParams)).toEqual({ resource_id: NESO_COUNTRY_RESOURCE_ID, sort: "datetime desc", limit: "200" });
  });

  it.each([
    ["HTTP error", new Response("nope", { status: 503 })],
    ["success=false", new Response(JSON.stringify({ success: false }))],
    ["no records", new Response(JSON.stringify({ success: true, result: {} }))],
  ])("throws on %s", async (_, res) => {
    const src = new NesoGridSource("https://neso.example", (async () => res) as typeof fetch);
    await expect(src.fetch()).rejects.toThrow(/NESO datastore/);
  });
});
