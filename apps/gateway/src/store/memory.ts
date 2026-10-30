import { randomUUID } from "node:crypto";
import { assertBalanced, computeHash, GENESIS_HASH, type JournalEntry, type JournalInput } from "../ledger/journal";
import type { CreditAccount, NewAccount, NewPayment, PaymentRow, PaymentStatus, PolicyEventRow, Store, UsageRow } from "./types";

/**
 * In-memory Store for tests and zero-dependency local runs. Not durable: never used when
 * NODE_ENV=production (config enforces DATABASE_URL).
 */
export class MemoryStore implements Store {
  private payments = new Map<string, PaymentRow>();
  private nonces = new Set<string>();
  private accounts = new Map<string, CreditAccount>();
  private keys = new Map<string, string>();
  private topups = new Set<string>();
  private usageRows = new Map<string, UsageRow[]>();
  private entries: JournalEntry[] = [];
  private events: PolicyEventRow[] = [];
  private conditions = new Map<string, { value: unknown; source: string; updatedAt: Date }>();

  async ping() {
    return true;
  }
  async close() {}

  private append(j: JournalInput) {
    assertBalanced(j.lines);
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS_HASH;
    this.entries.push({ ...j, seq: this.entries.length + 1, prevHash, hash: computeHash(prevHash, j) });
  }

  async insertPayment(p: NewPayment) {
    const k = `${p.network}|${p.payer.toLowerCase()}|${p.nonce}`;
    if (this.nonces.has(k)) return "duplicate" as const;
    this.nonces.add(k);
    const now = new Date();
    this.payments.set(p.id, { ...p, payer: p.payer.toLowerCase(), status: "verified", attempts: 0, txHash: null, error: null, createdAt: now, settledAt: null });
    return "inserted" as const;
  }

  async getPayment(id: string) {
    return this.payments.get(id) ?? null;
  }

  async claimDuePayments(now: Date, limit: number, leaseMs: number) {
    const due = [...this.payments.values()].filter((p) => p.status === "verified" && p.nextAttemptAt <= now).slice(0, limit);
    for (const p of due) p.nextAttemptAt = new Date(now.getTime() + leaseMs);
    return due.map((p) => ({ ...p }));
  }

  async settlePayment(id: string, txHash: string | null, journal: JournalInput) {
    const p = this.payments.get(id);
    if (!p || p.status !== "verified") return;
    this.append(journal);
    Object.assign(p, { status: "settled", txHash, settledAt: new Date(), error: null });
  }

  async failPayment(id: string, error: string, final: boolean, nextAttemptAt?: Date) {
    const p = this.payments.get(id);
    if (!p || p.status !== "verified") return;
    p.attempts++;
    p.error = error;
    if (final) p.status = "failed";
    else p.nextAttemptAt = nextAttemptAt ?? new Date();
  }

  async cancelPayment(id: string, reason: string) {
    const p = this.payments.get(id);
    if (p?.status === "verified") Object.assign(p, { status: "cancelled", error: reason });
  }

  async listPayments(opts: { status?: PaymentStatus; limit: number }) {
    return [...this.payments.values()]
      .filter((p) => !opts.status || p.status === opts.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.limit);
  }

  async unsettledByPayer() {
    const m = new Map<string, bigint>();
    for (const p of this.payments.values()) if (p.status === "verified") m.set(p.payer, (m.get(p.payer) ?? 0n) + p.amountAtomic);
    return [...m].map(([payer, atomic]) => ({ payer, atomic }));
  }

  async createAccount(a: NewAccount, keyHash: string, _keyPrefix: string) {
    const acct: CreditAccount = { id: randomUUID(), ...a, balanceMicros: 0, status: "active", createdAt: new Date() };
    this.accounts.set(acct.id, acct);
    this.keys.set(keyHash, acct.id);
    return { ...acct };
  }

  async accountByKeyHash(hash: string) {
    const id = this.keys.get(hash);
    return id ? { ...this.accounts.get(id)! } : null;
  }

  async getAccount(id: string) {
    const a = this.accounts.get(id);
    return a ? { ...a } : null;
  }

  async debit(accountId: string, micros: number, endpoint: string, journal: JournalInput) {
    const a = this.accounts.get(accountId);
    if (!a || a.status !== "active" || a.balanceMicros < micros) return { ok: false, balanceMicros: a?.balanceMicros ?? 0 };
    this.append(journal);
    a.balanceMicros -= micros;
    const rows = this.usageRows.get(accountId) ?? [];
    rows.push({ endpoint, micros, at: new Date() });
    this.usageRows.set(accountId, rows);
    return { ok: true, balanceMicros: a.balanceMicros };
  }

  async refund(accountId: string, micros: number, journal: JournalInput) {
    const a = this.accounts.get(accountId);
    if (!a) return;
    this.append(journal);
    a.balanceMicros += micros;
  }

  async applyTopUp(t: { ref: string; accountId: string; netMicros: number; vatMicros: number }, journal: JournalInput) {
    if (this.topups.has(t.ref)) return "duplicate" as const;
    const a = this.accounts.get(t.accountId);
    if (!a) throw new Error(`unknown account ${t.accountId}`);
    this.append(journal);
    this.topups.add(t.ref);
    a.balanceMicros += t.netMicros;
    return "applied" as const;
  }

  async usage(accountId: string, limit: number) {
    return (this.usageRows.get(accountId) ?? []).slice(-limit).reverse();
  }

  async journal(range?: { from?: Date; to?: Date }) {
    return this.entries.filter((e) => {
      const t = new Date(e.occurredAt);
      return (!range?.from || t >= range.from) && (!range?.to || t < range.to);
    });
  }

  async addPolicyEvents(accountId: string, events: unknown[]) {
    const receivedAt = new Date();
    for (const event of events) this.events.push({ accountId, event, receivedAt });
    if (this.events.length > 10_000) this.events.splice(0, this.events.length - 10_000);
  }

  async listPolicyEvents(limit: number) {
    return this.events.slice(-limit).reverse();
  }

  async setCondition(id: string, value: unknown, source: string) {
    this.conditions.set(id, { value, source, updatedAt: new Date() });
  }

  async getCondition(id: string) {
    return this.conditions.get(id) ?? null;
  }
}
