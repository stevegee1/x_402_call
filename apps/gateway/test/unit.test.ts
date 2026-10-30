import type { AisEvent } from "@mx/shared";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/payments/breaker";
import { ExposureTracker } from "../src/payments/exposure";
import { assertBalanced, computeHash, creditsUsageJournal, GENESIS_HASH, verifyChain, type JournalEntry } from "../src/ledger/journal";
import { creditsVat, splitInclusive, validateTaxId } from "../src/ledger/vat";
import { SnapshotEngine } from "../src/snapshot/engine";
import { WorldState } from "../src/snapshot/state";

describe("VAT", () => {
  it("extracts VAT from inclusive prices without losing pennies", () => {
    expect(splitInclusive(26_400)).toEqual({ netMicros: 22_000, vatMicros: 4_400 });
    const { netMicros, vatMicros } = splitInclusive(33_333);
    expect(netMicros + vatMicros).toBe(33_333);
  });
  it("charges UK standard rate and reverse-charges non-UK businesses", () => {
    expect(creditsVat("GB", 20_000_000)).toEqual({ treatment: "uk_standard", vatMicros: 4_000_000, grossMicros: 24_000_000 });
    expect(creditsVat("DE", 20_000_000)).toEqual({ treatment: "reverse_charge", vatMicros: 0, grossMicros: 20_000_000 });
  });
  it("validates tax ids", () => {
    expect(validateTaxId("GB", undefined)).toBeNull();
    expect(validateTaxId("GB", "GB123456789")).toBeNull();
    expect(validateTaxId("GB", "123")).not.toBeNull();
    expect(validateTaxId("FR", undefined)).not.toBeNull();
  });
});

describe("ledger", () => {
  it("rejects unbalanced journals", () => {
    expect(() => assertBalanced([{ account: "a", debit: 10, credit: 0 }, { account: "b", debit: 0, credit: 9 }])).toThrow(/unbalanced/);
  });
  it("detects tampering in the hash chain", () => {
    const entries: JournalEntry[] = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < 3; i++) {
      const j = creditsUsageJournal({ accountId: "a", micros: 25_000, endpoint: "vessels", ref: `r${i}`, occurredAt: new Date(i).toISOString() });
      const hash = computeHash(prev, j);
      entries.push({ ...j, seq: i + 1, prevHash: prev, hash });
      prev = hash;
    }
    expect(verifyChain(entries)).toEqual({ ok: true });
    entries[1]!.lines[0]!.debit = 1;
    expect(verifyChain(entries)).toEqual({ ok: false, brokenAtSeq: 2 });
  });
});

describe("circuit breaker", () => {
  it("opens on failure rate, half-opens after the cool-off, closes on success", async () => {
    let t = 0;
    const now = () => t;
    const b = new CircuitBreaker("x", { windowMs: 10_000, minCalls: 4, failureRate: 0.5, slowCallMs: 100, openMs: 1_000 });
    const fail = () => Promise.reject(new Error("boom"));
    for (let i = 0; i < 4; i++) await b.exec(fail, now).catch(() => {});
    expect(b.state).toBe("open");
    await expect(b.exec(async () => 1, now)).rejects.toThrow(/open/);
    t = 2_000;
    expect(await b.exec(async () => 1, now)).toBe(1);
    expect(b.state).toBe("closed");
  });
});

describe("exposure", () => {
  it("enforces global and per-payer caps", () => {
    const e = new ExposureTracker(100_000n, 50_000n);
    e.add("0xA", 33_000n);
    expect(e.wouldExceed("0xa", 33_000n)).toBe(true);
    expect(e.wouldExceed("0xb", 33_000n)).toBe(false);
    e.add("0xB", 33_000n);
    expect(e.wouldExceed("0xc", 66_000n)).toBe(true);
    e.release("0xa", 33_000n);
    expect(e.total).toBe(33_000n);
  });
});

describe("snapshot engine and derived signals", () => {
  const pos = (mmsi: number, lon: number, lat: number, ts: number, sog = 12, navStatus = 0): AisEvent => ({
    kind: "position",
    region: "dover",
    data: { mmsi, lon, lat, ts, sog, navStatus, cog: 45, source: "t", mode: "live" },
  });

  it("builds immutable snapshots with freshness metadata", () => {
    const w = new WorldState();
    const now = Date.now();
    w.apply(pos(1, 1.5, 51.0, now), now);
    const eng = new SnapshotEngine(w, 250);
    eng.buildAll(now);
    const s1 = eng.get("dover");
    w.apply(pos(2, 1.6, 51.05, now), now);
    eng.buildAll(now + 250);
    const s2 = eng.get("dover");
    expect(s1.vessels).toHaveLength(1); // old snapshot untouched
    expect(s2.vessels).toHaveLength(2);
    expect(s2.seq).toBeGreaterThan(s1.seq);
    expect(JSON.parse(s2.bodies.vessels)).toMatchObject({ region: "dover", mode: "live", degraded: false, count: 2 });
    expect(eng.get("panama").stale).toBe(true); // no data => stale => not sold
  });

  it("measures anchorage waiting time", () => {
    const w = new WorldState();
    const t0 = Date.now() - 3 * 3_600_000;
    w.apply(pos(7, 1.47, 51.23, t0, 0, 1), t0); // inside The Downs, at anchor
    w.apply(pos(7, 1.471, 51.231, Date.now() - 60_000, 0, 1));
    const eng = new SnapshotEngine(w, 250);
    const q = JSON.parse(eng.get("dover").bodies.queue).data;
    expect(q.anchorages[0]).toMatchObject({ id: "downs", waiting: 1 });
    expect(q.anchorages[0].wait_hours.max).toBeGreaterThan(2.9);
  });

  it("flags vessels going dark mid-strait and position jumps", () => {
    const w = new WorldState();
    const now = Date.now();
    w.apply(pos(10, 1.5, 51.0, now - 15 * 60_000, 14), now - 15 * 60_000); // underway, then silent 15 min
    w.apply(pos(11, 1.5, 51.0, now - 60_000), now - 60_000);
    w.apply(pos(11, 1.9, 51.3, now - 30_000), now - 30_000); // ~20nm in 30s
    const eng = new SnapshotEngine(w, 250);
    eng.buildAll(now);
    const types = JSON.parse(eng.get("dover").bodies.anomalies).data.map((a: { type: string; mmsi: number }) => `${a.type}:${a.mmsi}`);
    expect(types).toContain("ais_gap:10");
    expect(types).toContain("position_jump:11");
  });
});
