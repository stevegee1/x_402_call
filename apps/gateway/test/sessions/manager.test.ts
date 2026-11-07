import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Metrics } from "../../src/metrics";
import { SessionManager } from "../../src/sessions/manager";
import { SessionTokens } from "../../src/sessions/tokens";
import type { ReserveResult, SessionRow, SessionUsage, Store } from "../../src/store/types";

const SECRET = "unit-session-secret-0123456789abcdef0123";
const NOW = Date.parse("2026-11-07T15:00:00Z");

describe("SessionTokens", () => {
  const t = new SessionTokens(SECRET);
  const id = randomUUID();

  it("issues tokens that verify back to the session id", () => {
    expect(t.verify(t.issue(id))).toBe(id);
  });

  it("rejects anything not issued with this secret", () => {
    const tok = t.issue(id);
    expect(new SessionTokens(`${SECRET}x`).verify(tok)).toBeNull();
    expect(t.verify(tok.replace(id, randomUUID()))).toBeNull();
    expect(t.verify(`${tok}A`)).toBeNull();
    for (const bad of ["", "ses_", `ses_${id}`, `ses_${id}.`, `ses_not-a-uuid.${tok.split(".")[1]}`, `xyz_${id}.${tok.split(".")[1]}`]) expect(t.verify(bad)).toBeNull();
  });

  it("refuses a weak secret and a non-uuid id", () => {
    expect(() => new SessionTokens("short")).toThrow(/at least 32/);
    expect(() => t.issue("42")).toThrow(/uuid/);
  });
});

/** A store double for the session methods only, with controllable latency and failures. */
class FakeStore {
  amount = 1_000_000n;
  reserved = 0n;
  spent = 0n;
  expiresAt = NOW + 3_600_000;
  reserveCalls = 0;
  failReserve = false;
  failUsage = 0;
  reason?: Extract<ReserveResult, { ok: false }>["reason"];
  gate?: Promise<void>;
  reports: SessionUsage[] = [];

  session(): SessionRow {
    return { paymentId: "s", payer: "0x", amountAtomic: this.amount, reservedAtomic: this.reserved, spentAtomic: this.spent, netGbpMicros: 1, releasedGbpMicros: 0, createdAt: new Date(NOW), expiresAt: new Date(this.expiresAt), closedAt: null };
  }
  async reserveSession(_id: string, chunk: bigint, now: Date): Promise<ReserveResult> {
    this.reserveCalls++;
    await this.gate;
    if (this.failReserve) throw new Error("db down");
    if (this.reason) return { ok: false, reason: this.reason };
    if (now.getTime() >= this.expiresAt) return { ok: false, reason: "expired" };
    const free = this.amount - this.reserved;
    if (free <= 0n) return { ok: false, reason: "exhausted" };
    const g = chunk < free ? chunk : free;
    this.reserved += g;
    return { ok: true, grantedAtomic: g, session: this.session() };
  }
  async recordSessionUsage(_id: string, u: SessionUsage): Promise<void> {
    if (this.failUsage > 0) {
      this.failUsage--;
      throw new Error("db down");
    }
    this.reports.push(u);
    for (const v of u.byResource.values()) this.spent += v;
    this.reserved -= u.returnedAtomic;
  }
  async closeExpiredSessions() {
    return 0;
  }
}

function setup(lease = 100_000n) {
  let now = NOW;
  const store = new FakeStore();
  const quiet = { info: () => {}, warn: () => {} };
  const m = new SessionManager(store as unknown as Store, { secret: SECRET, ttlMs: 3_600_000, leaseAtomic: lease, flushMs: 1_000, graceMs: 1 }, quiet, new Metrics(), () => now);
  const token = m.tokens.issue(randomUUID());
  return { m, store, token, advance: (ms: number) => (now += ms) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SessionManager", () => {
  it("leases on first use, then spends from memory without touching the store", async () => {
    const { m, store, token } = setup();
    for (let i = 0; i < 4; i++) expect((await m.charge(token, "r", 10_000n)).ok).toBe(true);
    expect(store.reserveCalls).toBe(1);
  });

  it("reserves the next chunk in the background before the lease runs out", async () => {
    const { m, store, token } = setup();
    for (let i = 0; i < 6; i++) await m.charge(token, "r", 10_000n); // 40k left < half a lease
    await tick();
    expect(store.reserveCalls).toBe(2);
    expect(store.reserved).toBe(200_000n);
  });

  it("concurrent charges while a reservation is in flight never overspend", async () => {
    const { m, store, token } = setup(50_000n);
    store.amount = 100_000n;
    let open!: () => void;
    store.gate = new Promise((r) => (open = r));
    const pending = Array.from({ length: 30 }, () => m.charge(token, "r", 10_000n));
    open();
    const results = await Promise.all(pending);
    let charged = 0n;
    for (const r of results) if (r.ok) charged += r.ticket.priceAtomic;
    for (let i = 0; i < 20; i++) {
      const r = await m.charge(token, "r", 10_000n);
      if (r.ok) charged += r.ticket.priceAtomic;
    }
    expect(charged).toBe(100_000n);
  });

  it("a price larger than the lease chunk reserves enough for it", async () => {
    const { m, store, token } = setup(10_000n);
    expect((await m.charge(token, "r", 300_000n)).ok).toBe(true);
    await tick();
    expect(store.reserved).toBe(310_000n); // 300k for the price, then a one-chunk top-up in the background
  });

  it("maps store answers to charge results", async () => {
    const cases: Array<[Partial<FakeStore>, string]> = [
      [{ failReserve: true }, "unavailable"],
      [{ reason: "unknown" }, "unknown"],
      [{ reason: "not_a_session" }, "not_a_session"],
      [{ reason: "closed" }, "closed"],
      [{ amount: 0n }, "exhausted"],
      [{ expiresAt: NOW }, "expired"],
    ];
    for (const [over, reason] of cases) {
      const { m, store, token } = setup();
      Object.assign(store, over);
      expect(await m.charge(token, "r", 10_000n)).toEqual({ ok: false, reason });
    }
    expect(await setup().m.charge("ses_forged", "r", 1n)).toEqual({ ok: false, reason: "invalid" });
  });

  it("recovers from a store outage on the next charge", async () => {
    const { m, store, token } = setup();
    store.failReserve = true;
    expect(await m.charge(token, "r", 10_000n)).toEqual({ ok: false, reason: "unavailable" });
    store.failReserve = false;
    expect((await m.charge(token, "r", 10_000n)).ok).toBe(true);
  });

  it("stops charging at expiry, locally, without asking the store", async () => {
    const { m, store, token, advance } = setup();
    await m.charge(token, "r", 10_000n);
    advance(3_600_000);
    const calls = store.reserveCalls;
    expect(await m.charge(token, "r", 10_000n)).toEqual({ ok: false, reason: "expired" });
    expect(store.reserveCalls).toBe(calls);
  });

  it("refund puts the balance and the spend back", async () => {
    const { m, store, token } = setup();
    const r = await m.charge(token, "r", 10_000n);
    if (!r.ok) throw new Error("charge failed");
    m.refund(r.ticket);
    await m.flush();
    expect(store.reports).toEqual([]);
    expect(m.remaining(r.ticket.sessionId)).toBe(1_000_000n);
  });

  it("flush reports spend by resource; a failed report is kept and retried", async () => {
    const { m, store, token } = setup();
    await m.charge(token, "a", 10_000n);
    await m.charge(token, "b", 20_000n);
    store.failUsage = 1;
    await m.flush();
    expect(store.reports).toEqual([]);
    await m.charge(token, "a", 10_000n);
    await m.flush();
    expect(store.reports).toHaveLength(1);
    expect([...store.reports[0]!.byResource]).toEqual([
      ["a", 20_000n],
      ["b", 20_000n],
    ]);
    expect(store.spent).toBe(40_000n);
  });

  it("charges made during a flush are kept for the next one", async () => {
    const { m, store, token } = setup();
    await m.charge(token, "a", 10_000n);
    const f = m.flush();
    await m.charge(token, "a", 10_000n);
    await f;
    await m.flush();
    expect(store.spent).toBe(20_000n);
  });

  it("drains on stop: spend reported, unspent lease returned", async () => {
    const { m, store, token } = setup();
    await m.charge(token, "a", 10_000n);
    await m.stop();
    expect(store.spent).toBe(10_000n);
    expect(store.reserved).toBe(10_000n);
  });

  it("returns expired leases on flush", async () => {
    const { m, store, token, advance } = setup();
    await m.charge(token, "a", 10_000n);
    advance(3_600_001);
    await m.flush();
    expect(store.reserved).toBe(10_000n);
    expect(m.remaining(m.tokens.verify(token)!)).toBeNull(); // lease dropped
  });

  it("hands an idle lease back so other replicas can use it", async () => {
    const { m, store, token, advance } = setup();
    await m.charge(token, "a", 10_000n);
    advance(5_000);
    await m.flush();
    expect(store.reserved).toBe(100_000n); // still in use
    advance(5_000);
    await m.flush();
    expect(store.reserved).toBe(10_000n); // idle 10 s: returned
    expect((await m.charge(token, "a", 10_000n)).ok).toBe(true); // and leased again on the next read
  });
});
