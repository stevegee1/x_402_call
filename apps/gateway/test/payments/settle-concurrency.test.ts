import { describe, expect, it } from "vitest";
import { loadConfig, settleConcurrency } from "../../src/config";
import { FailoverFacilitator, Semaphore } from "../../src/payments/facilitator";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("settlement concurrency cap", () => {
  it("never runs more than max at once, and runs the rest in arrival order", async () => {
    const s = new Semaphore(2);
    let peak = 0;
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const tasks = [0, 1, 2, 3, 4].map((i) =>
      s.run(async () => {
        peak = Math.max(peak, s.inFlight);
        order.push(i);
        await new Promise<void>((r) => releases.push(r));
        return i;
      }),
    );
    await tick();
    expect(order).toEqual([0, 1]); // two started, three waiting
    while (releases.length) {
      releases.shift()!();
      await tick();
      await tick();
    }
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("a failing task frees its slot", async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await s.run(async () => "next")).toBe("next");
    expect(s.inFlight).toBe(0);
  });

  it("caps settles at the facilitator; verify is never queued", async () => {
    let settling = 0;
    let peak = 0;
    let gate!: () => void;
    const open = new Promise<void>((r) => (gate = r));
    const inner = {
      verify: async () => ({ isValid: true }),
      settle: async () => {
        settling++;
        peak = Math.max(peak, settling);
        await open;
        settling--;
        return { success: true, transaction: "0x", network: "eip155:84532" };
      },
      getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
    };
    const f = new FailoverFacilitator(inner as never, undefined, undefined, { windowMs: 30_000, minCalls: 100, failureRate: 1, slowCallMs: 60_000, openMs: 1 }).limitSettles(2);
    const settles = Array.from({ length: 5 }, () => f.settle({} as never, {} as never));
    await tick();
    expect(settling).toBe(2);
    expect((await f.verify({} as never, {} as never)).isValid).toBe(true); // not blocked by queued settles
    gate();
    await Promise.all(settles);
    expect(peak).toBe(2);
  });

  it("defaults: 2 on the public x402.org facilitator, 16 elsewhere, or as configured", () => {
    const base = { PAY_TO: "0x35E13c683A70fBe048CDB897cE1bAe36440fcd19" };
    expect(settleConcurrency(loadConfig({ ...base, FACILITATOR: "x402org" }))).toBe(2);
    expect(settleConcurrency(loadConfig({ ...base, FACILITATOR: "url", FACILITATOR_URL: "http://f.test" }))).toBe(16);
    expect(settleConcurrency(loadConfig({ ...base, SETTLE_MAX_CONCURRENCY: "0" }))).toBe(0);
    expect(() => loadConfig({ ...base, SETTLE_MAX_CONCURRENCY: "-1" })).toThrow();
  });
});
