import type { Store } from "../store/types";
import { SessionTokens } from "./tokens";

export interface SessionOptions {
  secret: string;
  /** How long a session lasts after its payment settles. */
  ttlMs: number;
  /** How much of a balance one replica leases at a time (USDC atomic). Bounds what a crash can strand. */
  leaseAtomic: bigint;
  /** How often usage is reported to the store (and journalled). */
  flushMs: number;
  /** Expired sessions close this long after expiry, once every replica has reported. */
  graceMs: number;
  /**
   * A lease unused this long is handed back on the next flush, so another replica can take it.
   * Without this, balance left on a replica the buyer stopped hitting would be stranded until expiry.
   */
  idleReturnMs?: number;
}

const DEFAULT_IDLE_RETURN_MS = 10_000;

export interface SessionLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface SessionMetrics {
  inc(name: string, labels?: Record<string, string>, by?: number): void;
  set(name: string, value: number, labels?: Record<string, string>): void;
}

export type ChargeResult =
  | { ok: true; ticket: Ticket; remainingAtomic: bigint }
  | { ok: false; reason: "invalid" | "unknown" | "not_a_session" | "not_settled" | "expired" | "closed" | "exhausted" | "unavailable" };

/** Proof of one charge, used to refund it if the handler fails. */
export interface Ticket {
  sessionId: string;
  resourceId: string;
  priceAtomic: bigint;
}

type ReserveOutcome = "granted" | "exhausted" | "expired" | "dead" | "error";

/** This replica's lease on one session: balance to spend from memory, and spend not yet reported. */
interface Lease {
  available: bigint;
  /** Session balance not yet leased by anyone, as of our last reservation (for the remaining-balance header). */
  unreservedAtomic: bigint;
  expiresAt: number;
  spent: Map<string, bigint>;
  lastUsedAt: number;
  reserving?: Promise<ReserveOutcome>;
  dead?: ChargeResult & { ok: false };
}

/**
 * Spends x402 session balances from memory (architecture.md §6.4). A charge is an HMAC check and a
 * subtraction: no facilitator, no chain, no database. The balance is leased from the store in
 * chunks. The next chunk is reserved in the background once a lease runs below half, so reads
 * rarely wait. Spend is reported every flushMs, which journals the matching revenue.
 *
 * Failure bounds: a crash loses this replica's unreported spend (revenue then goes to breakage,
 * the same total) and strands at most one lease per session until expiry. Neither can let a buyer
 * spend more than they paid: leases never exceed the session amount.
 */
export class SessionManager {
  readonly tokens: SessionTokens;
  private readonly leases = new Map<string, Lease>();
  private flushTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private flushing?: Promise<void>;

  constructor(
    private readonly store: Store,
    readonly opts: SessionOptions,
    private readonly log: SessionLog,
    private readonly metrics: SessionMetrics,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = new SessionTokens(opts.secret);
  }

  start(): void {
    this.flushTimer = setInterval(() => void this.flush(), this.opts.flushMs);
    this.flushTimer.unref();
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  /** Reports everything and hands every unspent lease back, so other replicas can use it. */
  async stop(): Promise<void> {
    clearInterval(this.flushTimer);
    clearInterval(this.sweepTimer);
    await this.flush(true);
  }

  async charge(token: string, resourceId: string, priceAtomic: bigint): Promise<ChargeResult> {
    const id = this.tokens.verify(token);
    if (!id) return { ok: false, reason: "invalid" };
    let lease = this.leases.get(id);
    if (lease?.dead) return lease.dead;
    if (lease && lease.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    if (!lease || lease.available < priceAtomic) {
      if (!lease) {
        lease = { available: 0n, unreservedAtomic: 0n, expiresAt: Number.MAX_SAFE_INTEGER, spent: new Map(), lastUsedAt: this.now() };
        this.leases.set(id, lease);
      }
      const outcome = await this.reserve(id, lease, priceAtomic);
      if (lease.dead) return lease.dead;
      // Re-checked after the await and decremented below without another one, so concurrent
      // charges can never spend the same balance twice.
      if (lease.available < priceAtomic) {
        if (lease.expiresAt <= this.now()) return { ok: false, reason: "expired" };
        return { ok: false, reason: outcome === "error" ? "unavailable" : "exhausted" };
      }
    }
    lease.available -= priceAtomic;
    lease.spent.set(resourceId, (lease.spent.get(resourceId) ?? 0n) + priceAtomic);
    lease.lastUsedAt = this.now();
    // Top up ahead of need, off the request path.
    if (lease.available < this.opts.leaseAtomic / 2n && lease.unreservedAtomic > 0n && !lease.reserving) void this.reserve(id, lease, 0n);
    this.metrics.inc("session_charges_total", { resource: resourceId });
    return { ok: true, ticket: { sessionId: id, resourceId, priceAtomic }, remainingAtomic: lease.available + lease.unreservedAtomic };
  }

  /** Undoes a charge whose handler failed (I5). */
  refund(t: Ticket): void {
    const lease = this.leases.get(t.sessionId);
    if (!lease) return;
    lease.available += t.priceAtomic;
    const s = (lease.spent.get(t.resourceId) ?? 0n) - t.priceAtomic;
    if (s > 0n) lease.spent.set(t.resourceId, s);
    else lease.spent.delete(t.resourceId);
    this.metrics.inc("session_refunds_total", { resource: t.resourceId });
  }

  /** Remaining balance as this replica sees it (exact with one replica). */
  remaining(sessionId: string): bigint | null {
    const l = this.leases.get(sessionId);
    return l ? l.available + l.unreservedAtomic : null;
  }

  /**
   * Leases more balance: enough for `need`, at least one lease chunk. Concurrent callers share one
   * reservation.
   */
  private reserve(id: string, lease: Lease, need: bigint): Promise<ReserveOutcome> {
    if (lease.reserving) return lease.reserving;
    const chunk = need > this.opts.leaseAtomic ? need : this.opts.leaseAtomic;
    lease.reserving = (async () => {
      try {
        const r = await this.store.reserveSession(id, chunk, new Date(this.now()), this.opts.ttlMs);
        if (!r.ok) {
          // Exhausted is normal: the balance may still have this replica's lease left to spend.
          if (r.reason === "exhausted") {
            lease.unreservedAtomic = 0n;
            return "exhausted";
          }
          if (r.reason === "expired") {
            lease.expiresAt = Math.min(lease.expiresAt, this.now());
            return "expired";
          }
          lease.dead = { ok: false, reason: r.reason };
          return "dead";
        }
        lease.available += r.grantedAtomic;
        lease.expiresAt = r.session.expiresAt.getTime();
        lease.unreservedAtomic = r.session.amountAtomic - r.session.reservedAtomic;
        this.metrics.inc("session_leases_total");
        return "granted";
      } catch (e) {
        this.log.warn({ err: (e as Error).message, session: id }, "session lease failed");
        this.metrics.inc("session_lease_errors_total");
        return "error";
      } finally {
        lease.reserving = undefined;
      }
    })();
    return lease.reserving;
  }

  /**
   * Reports spend since the last flush. Expired leases (or all of them, when draining) also hand
   * their unspent balance back and are dropped. A failed report is kept and retried next time.
   */
  flush(drain = false): Promise<void> {
    if (this.flushing) return this.flushing.then(() => (drain ? this.flush(true) : undefined));
    this.flushing = (async () => {
      const t = this.now();
      for (const [id, lease] of this.leases) {
        if (lease.reserving) await lease.reserving.catch(() => {});
        const idle = t - lease.lastUsedAt >= (this.opts.idleReturnMs ?? DEFAULT_IDLE_RETURN_MS);
        const closing = drain || idle || lease.expiresAt <= t || lease.dead !== undefined;
        if (lease.spent.size === 0 && !(closing && lease.available > 0n)) {
          if (closing) this.leases.delete(id);
          continue;
        }
        // Take the report out first: charges can continue while it is written.
        const byResource = lease.spent;
        lease.spent = new Map();
        const returnedAtomic = closing ? lease.available : 0n;
        if (closing) lease.available = 0n;
        try {
          await this.store.recordSessionUsage(id, { byResource, returnedAtomic }, new Date(t));
          if (closing) this.leases.delete(id);
        } catch (e) {
          for (const [r, v] of byResource) lease.spent.set(r, (lease.spent.get(r) ?? 0n) + v);
          lease.available += returnedAtomic;
          this.log.warn({ err: (e as Error).message, session: id }, "session usage report failed; will retry");
          this.metrics.inc("session_flush_errors_total");
        }
      }
      this.metrics.set("session_leases_open", this.leases.size);
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** Closes sessions past expiry + grace and books what was never used. */
  async sweep(): Promise<number> {
    try {
      const n = await this.store.closeExpiredSessions(new Date(this.now()), this.opts.graceMs);
      if (n > 0) this.log.info({ closed: n }, "expired sessions closed");
      return n;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "session sweep failed");
      return 0;
    }
  }
}
