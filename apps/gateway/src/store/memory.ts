import { randomUUID } from "node:crypto";
import {
  assertBalanced,
  computeHash,
  GENESIS_HASH,
  isSessionPurchase,
  normalizeJournal,
  sessionBreakageJournal,
  sessionRelease,
  sessionUsageJournal,
  x402Gbp,
  type JournalEntry,
  type JournalInput,
} from "../ledger/journal";
import type { AdmitOptions, Admission, ApiKeyInfo, CreditAccount, CustomerUser, NewAccount, NewPayment, PaymentRow, PaymentStatus, PolicyEventRow, ReserveResult, SessionRow, SessionUsage, Store, SyncReason, UsageRow } from "./types";

/**
 * In-memory Store for tests and zero-dependency local runs. Not durable: never used when
 * NODE_ENV=production (config enforces DATABASE_URL).
 */
export class MemoryStore implements Store {
  private payments = new Map<string, PaymentRow>();
  private nonces = new Set<string>();
  private accounts = new Map<string, CreditAccount>();
  private keys = new Map<string, string>();
  private keyInfo = new Map<string, ApiKeyInfo & { hash: string; accountId: string }>();
  private users = new Map<string, CustomerUser>();
  private webSessions = new Map<string, { userId: string; expiresAt: Date; revokedAt: Date | null }>();
  private topups = new Set<string>();
  private usageRows = new Map<string, UsageRow[]>();
  private entries: JournalEntry[] = [];
  private events: PolicyEventRow[] = [];
  private conditions = new Map<string, { value: unknown; source: string; updatedAt: Date }>();
  private sessions = new Map<string, SessionRow>();

  async ping() {
    return true;
  }
  async close() {}

  private append(input: JournalInput) {
    const j = normalizeJournal(input);
    assertBalanced(j.lines);
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS_HASH;
    this.entries.push({ ...j, seq: this.entries.length + 1, prevHash, hash: computeHash(prevHash, j) });
  }

  async insertPayment(p: NewPayment) {
    const k = `${p.network}|${p.payer.toLowerCase()}|${p.nonce}`;
    if (this.nonces.has(k)) return "duplicate" as const;
    this.nonces.add(k);
    const now = new Date();
    this.payments.set(p.id, { ...p, payer: p.payer.toLowerCase(), status: "verified", settleMode: p.settleMode ?? "async", attempts: 0, txHash: null, error: null, createdAt: now, settledAt: null });
    return "inserted" as const;
  }

  async getPayment(id: string) {
    return this.payments.get(id) ?? null;
  }

  async claimDuePayments(now: Date, limit: number, leaseMs: number) {
    const due = [...this.payments.values()]
      .filter((p) => p.status === "verified" && p.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
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
    // Mirrors PgStore: error truncated to 1000 chars; next attempt unchanged unless given.
    p.attempts++;
    p.error = error.slice(0, 1_000);
    if (final) p.status = "failed";
    if (nextAttemptAt) p.nextAttemptAt = nextAttemptAt;
  }

  async cancelPayment(id: string, reason: string) {
    const p = this.payments.get(id);
    if (p?.status === "verified") Object.assign(p, { status: "cancelled", error: reason });
  }

  async listPayments(opts: { status?: PaymentStatus; limit: number; before?: string }) {
    // Mirrors PgStore: order by (created_at, id) descending; `before` is an exclusive cursor (a payment id).
    const cmp = (a: PaymentRow, b: PaymentRow) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const anchor = opts.before ? this.payments.get(opts.before) : undefined;
    if (opts.before && !anchor) return [];
    return [...this.payments.values()]
      .filter((p) => (!opts.status || p.status === opts.status) && (!anchor || cmp(p, anchor) < 0))
      .sort((a, b) => -cmp(a, b))
      .slice(0, opts.limit);
  }

  /** Unsettled async exposure, plus (with a hold) async payments that failed for good since `heldSince`. */
  private exposureOf(payer?: string, heldSince?: Date) {
    let total = 0n;
    let mine = 0n;
    const payers = new Set<string>();
    for (const p of this.payments.values()) {
      if (p.settleMode !== "async") continue;
      const counts = p.status === "verified" || (heldSince !== undefined && p.status === "failed" && p.createdAt > heldSince);
      if (!counts) continue;
      total += p.amountAtomic;
      payers.add(p.payer);
      if (payer && p.payer === payer.toLowerCase()) mine += p.amountAtomic;
    }
    return { total, mine, payers: payers.size };
  }

  private demoted(payer: string, since: Date) {
    const who = payer.toLowerCase();
    for (const p of this.payments.values()) if (p.payer === who && p.settleMode === "async" && p.status === "failed" && p.createdAt > since) return true;
    return false;
  }

  // Single-threaded: check and insert happen with no await between them, so admission is atomic.
  async admitPayment(p: Omit<NewPayment, "nextAttemptAt" | "settleMode">, o: AdmitOptions): Promise<Admission> {
    let mode: "async" | "sync" = "sync";
    let syncReason: SyncReason | undefined;
    if (o.wantAsync) {
      if (this.demoted(p.payer, new Date(o.now.getTime() - o.failures.demoteMs))) syncReason = "demoted";
      else {
        const e = this.exposureOf(p.payer, new Date(o.now.getTime() - o.failures.holdMs));
        if (e.total + p.amountAtomic <= o.caps.totalAtomic && e.mine + p.amountAtomic <= o.caps.perPayerAtomic) mode = "async";
        else syncReason = "cap";
      }
    }
    const r = await this.insertPayment({ ...p, settleMode: mode, nextAttemptAt: mode === "async" ? o.asyncAttemptAt : o.syncAttemptAt });
    if (r === "duplicate") return { result: "duplicate" };
    return syncReason ? { result: "inserted", mode, syncReason } : { result: "inserted", mode };
  }

  async exposure() {
    const e = this.exposureOf();
    return { totalAtomic: e.total, payers: e.payers };
  }

  async createAccount(a: NewAccount, keyHash: string, keyPrefix: string) {
    return this.createAccountNow(a, keyHash, keyPrefix);
  }

  private createAccountNow(a: NewAccount, keyHash: string, keyPrefix: string): CreditAccount {
    const acct: CreditAccount = { id: randomUUID(), ...a, country: a.country.toUpperCase(), balanceMicros: 0, status: "active", createdAt: new Date() };
    this.accounts.set(acct.id, acct);
    this.addKeyNow(acct.id, keyHash, keyPrefix);
    return { ...acct };
  }

  private addKeyNow(accountId: string, hash: string, prefix: string): ApiKeyInfo {
    const k = { id: randomUUID(), prefix, createdAt: new Date(), revokedAt: null, hash, accountId };
    this.keyInfo.set(k.id, k);
    this.keys.set(hash, accountId);
    return { id: k.id, prefix, createdAt: k.createdAt, revokedAt: null };
  }

  // No await between the email check and the inserts, so concurrent sign-ups can't share an email.
  async createCustomer(a: NewAccount, user: { email: string; passwordHash: string }, key: { hash: string; prefix: string }) {
    const email = user.email.toLowerCase();
    for (const u of this.users.values()) if (u.email.toLowerCase() === email) return "email_taken" as const;
    const account = this.createAccountNow(a, key.hash, key.prefix);
    const u: CustomerUser = { id: randomUUID(), accountId: account.id, email: user.email, passwordHash: user.passwordHash, failedLogins: 0, lockedUntil: null, createdAt: new Date(), lastLoginAt: null };
    this.users.set(u.id, u);
    return { account, user: { ...u } };
  }

  async customerByEmail(email: string) {
    const e = email.toLowerCase();
    for (const u of this.users.values()) if (u.email.toLowerCase() === e) return { ...u };
    return null;
  }

  async recordLoginFailure(userId: string, now: Date, maxFailures: number, lockMs: number) {
    const u = this.users.get(userId);
    if (!u) return;
    if (u.failedLogins + 1 >= maxFailures) {
      u.failedLogins = 0;
      u.lockedUntil = new Date(now.getTime() + lockMs);
    } else u.failedLogins += 1;
  }

  async recordLoginSuccess(userId: string, now: Date) {
    const u = this.users.get(userId);
    if (!u) return;
    u.failedLogins = 0;
    u.lockedUntil = null;
    u.lastLoginAt = now;
  }

  async createWebSession(tokenHash: string, userId: string, expiresAt: Date) {
    this.webSessions.set(tokenHash, { userId, expiresAt, revokedAt: null });
  }

  async webSession(tokenHash: string, now: Date) {
    const s = this.webSessions.get(tokenHash);
    if (!s || s.revokedAt || s.expiresAt <= now) return null;
    const user = this.users.get(s.userId);
    const account = user && this.accounts.get(user.accountId);
    return user && account ? { user: { ...user }, account: { ...account } } : null;
  }

  async revokeWebSession(tokenHash: string) {
    const s = this.webSessions.get(tokenHash);
    if (s && !s.revokedAt) s.revokedAt = new Date();
  }

  async listApiKeys(accountId: string) {
    return [...this.keyInfo.values()]
      .filter((k) => k.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ id, prefix, createdAt, revokedAt }) => ({ id, prefix, createdAt, revokedAt }));
  }

  async addApiKey(accountId: string, hash: string, prefix: string) {
    return this.addKeyNow(accountId, hash, prefix);
  }

  async revokeApiKey(accountId: string, keyId: string) {
    const k = this.keyInfo.get(keyId);
    if (!k || k.accountId !== accountId || k.revokedAt) return false;
    k.revokedAt = new Date();
    this.keys.delete(k.hash);
    return true;
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
    if (!a) throw new Error(`unknown account ${accountId}`);
    this.append(journal);
    a.balanceMicros += micros;
    const rows = this.usageRows.get(accountId) ?? [];
    rows.push({ endpoint: "refund", micros: -micros, at: new Date() });
    this.usageRows.set(accountId, rows);
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

  async reserveSession(paymentId: string, chunkAtomic: bigint, now: Date, ttlMs: number): Promise<ReserveResult> {
    let sess = this.sessions.get(paymentId);
    if (!sess) {
      const p = this.payments.get(paymentId);
      if (!p) return { ok: false, reason: "unknown" };
      if (!isSessionPurchase(p.endpoint)) return { ok: false, reason: "not_a_session" };
      if (p.status !== "settled" || !p.settledAt) return { ok: false, reason: "not_settled" };
      sess = {
        paymentId,
        payer: p.payer,
        amountAtomic: p.amountAtomic,
        reservedAtomic: 0n,
        spentAtomic: 0n,
        netGbpMicros: x402Gbp(p.amountAtomic, p.fxRate).netMicros,
        releasedGbpMicros: 0,
        createdAt: now,
        expiresAt: new Date(p.settledAt.getTime() + ttlMs),
        closedAt: null,
      };
      this.sessions.set(paymentId, sess);
    }
    if (sess.closedAt) return { ok: false, reason: "closed" };
    if (sess.expiresAt <= now) return { ok: false, reason: "expired" };
    const free = sess.amountAtomic - sess.reservedAtomic;
    if (free <= 0n) return { ok: false, reason: "exhausted" };
    const granted = chunkAtomic < free ? chunkAtomic : free;
    sess.reservedAtomic += granted;
    return { ok: true, grantedAtomic: granted, session: { ...sess } };
  }

  async recordSessionUsage(paymentId: string, usage: SessionUsage, occurredAt: Date): Promise<void> {
    const sess = this.sessions.get(paymentId);
    if (!sess) throw new Error(`unknown session ${paymentId}`);
    let spent = 0n;
    for (const v of usage.byResource.values()) spent += v;
    if (spent + usage.returnedAtomic > sess.reservedAtomic - sess.spentAtomic) throw new Error(`session ${paymentId}: usage exceeds outstanding leases`);
    const release = sess.closedAt
      ? { releasedAfterMicros: sess.releasedGbpMicros, lines: [] }
      : sessionRelease({ netGbpMicros: sess.netGbpMicros, amountAtomic: sess.amountAtomic, spentBeforeAtomic: sess.spentAtomic, releasedBeforeMicros: sess.releasedGbpMicros, byResource: usage.byResource });
    if (release.lines.length) {
      const byResource = Object.fromEntries([...usage.byResource].map(([k, v]) => [k, v.toString()]));
      this.append(sessionUsageJournal({ sessionId: paymentId, lines: release.lines, spentAtomic: byResource, occurredAt: occurredAt.toISOString() }));
    }
    sess.spentAtomic += spent;
    sess.reservedAtomic -= usage.returnedAtomic;
    sess.releasedGbpMicros = release.releasedAfterMicros;
  }

  async closeExpiredSessions(now: Date, graceMs: number): Promise<number> {
    let n = 0;
    for (const sess of this.sessions.values()) {
      if (sess.closedAt || sess.expiresAt.getTime() + graceMs > now.getTime()) continue;
      const rest = sess.netGbpMicros - sess.releasedGbpMicros;
      if (rest > 0) this.append(sessionBreakageJournal({ sessionId: sess.paymentId, micros: rest, unusedAtomic: (sess.amountAtomic - sess.spentAtomic).toString(), occurredAt: now.toISOString() }));
      sess.releasedGbpMicros = sess.netGbpMicros;
      sess.closedAt = now;
      n++;
    }
    return n;
  }

  async getSession(paymentId: string): Promise<SessionRow | null> {
    const s = this.sessions.get(paymentId);
    return s ? { ...s } : null;
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
