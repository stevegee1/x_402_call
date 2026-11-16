import { describe, expect, it } from "vitest";
import {
  addDays,
  datePart,
  HALF_HOUR_MS,
  intOf,
  londonOffsetMs,
  londonWallClock,
  parseNaiveUtc,
  settlementDayStart,
  settlementPeriods,
  settlementPeriodStart,
} from "../src";

const Z = (s: string) => Date.parse(`${s}Z`);

describe("London time", () => {
  it("knows GMT from BST, including either side of each clock change (01:00 UTC)", () => {
    expect(londonOffsetMs(Z("2026-01-15T12:00:00"))).toBe(0);
    expect(londonOffsetMs(Z("2026-07-15T12:00:00"))).toBe(3_600_000);
    expect(londonOffsetMs(Z("2026-03-29T00:59:59"))).toBe(0);
    expect(londonOffsetMs(Z("2026-03-29T01:00:00"))).toBe(3_600_000);
    expect(londonOffsetMs(Z("2026-10-25T00:59:59"))).toBe(3_600_000);
    expect(londonOffsetMs(Z("2026-10-25T01:00:00"))).toBe(0);
  });

  it("shows UK wall-clock time, with the repeated hour on the autumn change", () => {
    expect(londonWallClock(Z("2026-11-17T00:30:00"))).toBe("2026-11-17T00:30");
    expect(londonWallClock(Z("2026-06-30T23:30:00"))).toBe("2026-07-01T00:30");
    expect(londonWallClock(Z("2026-10-25T00:30:00"))).toBe("2026-10-25T01:30");
    expect(londonWallClock(Z("2026-10-25T01:30:00"))).toBe("2026-10-25T01:30");
  });
});

describe("settlement periods", () => {
  it("starts the settlement day at UK local midnight", () => {
    expect(settlementDayStart("2026-11-17")).toBe(Z("2026-11-17T00:00:00"));
    expect(settlementDayStart("2025-07-15")).toBe(Z("2025-07-14T23:00:00"));
    expect(settlementDayStart("2026-03-29")).toBe(Z("2026-03-29T00:00:00")); // spring change: midnight is still GMT
    expect(settlementDayStart("2026-03-30")).toBe(Z("2026-03-29T23:00:00"));
    expect(settlementDayStart("2026-10-25")).toBe(Z("2026-10-24T23:00:00")); // autumn change: midnight is still BST
    expect(settlementDayStart("2026-10-26")).toBe(Z("2026-10-26T00:00:00"));
  });

  it("has 46 periods on the spring change, 50 on the autumn change, 48 otherwise", () => {
    expect(settlementPeriods("2026-03-29")).toBe(46);
    expect(settlementPeriods("2026-10-25")).toBe(50);
    expect(settlementPeriods("2026-11-17")).toBe(48);
    expect(settlementPeriods("2026-07-01")).toBe(48);
    expect(settlementPeriods("9999-12-31")).toBeNull(); // the next day is past the ISO range
    expect(settlementPeriods("2026-02-30")).toBeNull();
  });

  it("places each period, and refuses periods that don't exist that day", () => {
    expect(settlementPeriodStart("2026-11-17", 1)).toBe(Z("2026-11-17T00:00:00"));
    expect(settlementPeriodStart("2026-11-17", 21)).toBe(Z("2026-11-17T10:00:00"));
    expect(settlementPeriodStart("2026-11-17", 48)).toBe(Z("2026-11-17T23:30:00"));
    expect(settlementPeriodStart("2025-07-15", 1)).toBe(Z("2025-07-14T23:00:00"));
    expect(settlementPeriodStart("2026-10-25", 50)).toBe(Z("2026-10-25T23:30:00"));
    expect(settlementPeriodStart("2026-03-29", 46)).toBe(Z("2026-03-29T22:30:00"));
    for (const [d, p] of [
      ["2026-11-17", 0],
      ["2026-11-17", 49],
      ["2026-03-29", 47],
      ["2026-11-17", 1.5],
      ["2026-11-17", -1],
      ["2026-02-30", 1],
      ["17/11/2026", 1],
    ] as const) {
      expect(settlementPeriodStart(d, p)).toBeNull();
    }
  });

  it("tiles time without gaps or overlaps for every day from 2025 to 2029", () => {
    let date = "2025-01-01";
    const perYear = new Map<string, number[]>();
    while (date < "2030-01-01") {
      const n = settlementPeriods(date)!;
      const next = addDays(date, 1)!;
      expect(settlementDayStart(date)! + n * HALF_HOUR_MS).toBe(settlementDayStart(next));
      expect(settlementPeriodStart(date, n)! + HALF_HOUR_MS).toBe(settlementPeriodStart(next, 1));
      const y = date.slice(0, 4);
      if (n !== 48) perYear.set(y, [...(perYear.get(y) ?? []), n]);
      date = next;
    }
    // Exactly one short and one long day a year.
    for (let y = 2025; y <= 2029; y++) expect(perYear.get(String(y))).toEqual([46, 50]);
  });
});

describe("parsers", () => {
  it("reads naive timestamps as UTC and refuses zones and rollovers", () => {
    expect(parseNaiveUtc("2026-11-07T14:00:00")).toBe(Z("2026-11-07T14:00:00"));
    expect(parseNaiveUtc("2026-11-07T14:00")).toBe(Z("2026-11-07T14:00:00"));
    for (const v of ["2026-11-07T14:00:00Z", "2026-11-07T14:00:00+01:00", "2026-02-30T00:00:00", "2026-11-07T24:00:00", "2026-11-07", "", null, 1]) {
      expect(parseNaiveUtc(v)).toBeNull();
    }
  });

  it("takes the date of date-only values", () => {
    expect(datePart("2026-11-16")).toBe("2026-11-16");
    expect(datePart("2026-11-16T00:00:00")).toBe("2026-11-16");
    expect(datePart("2026-11-16T00:00")).toBe("2026-11-16");
    for (const v of ["2026-11-16T01:00:00", "2026-02-30", "20261116", 20261116, null]) expect(datePart(v)).toBeNull();
  });

  it("reads whole numbers from numbers and numeric strings only", () => {
    expect(intOf(21)).toBe(21);
    expect(intOf("21")).toBe(21);
    expect(intOf(" 7 ")).toBe(7);
    for (const v of [1.5, "1.5", "", "x", null, undefined, Number.NaN, true, "1e3"]) expect(intOf(v)).toBeNull();
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-30", 1)).toBeNull();
  });
});
