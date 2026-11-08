import { describe, expect, it } from "vitest";
import { pruneHistory, type Queryable } from "../src/retention";

/** A table of `remaining` old rows that deletes at most the requested batch per statement. */
function fakeDb(remaining: number) {
  const calls: unknown[][] = [];
  const db: Queryable = {
    async query(_sql, params) {
      calls.push(params);
      const n = Math.min(remaining, params[1] as number);
      remaining -= n;
      return { rowCount: n };
    },
  };
  return { db, calls, left: () => remaining };
}

describe("pruneHistory", () => {
  it("deletes in batches until a short batch says the backlog is gone", async () => {
    const f = fakeDb(25);
    expect(await pruneHistory(f.db, 30, { batch: 10 })).toBe(25);
    expect(f.calls).toEqual([[30, 10], [30, 10], [30, 10]]);
    expect(f.left()).toBe(0);
  });

  it("stops after maxBatches so one run can't monopolise the database", async () => {
    const f = fakeDb(1_000);
    expect(await pruneHistory(f.db, 30, { batch: 10, maxBatches: 3 })).toBe(30);
    expect(f.calls).toHaveLength(3);
  });

  it("keeps everything when retention is 0", async () => {
    const f = fakeDb(5);
    expect(await pruneHistory(f.db, 0)).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
});
