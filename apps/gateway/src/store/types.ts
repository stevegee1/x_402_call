import type { JournalEntry, JournalInput } from "../ledger/journal";

export type PaymentStatus = "verified" | "settled" | "failed" | "cancelled";
/** async: served before settlement (carries exposure). sync: settled before anything is served. */
export type SettleMode = "async" | "sync";

export interface PaymentRow {
  id: string;
  network: string;
  payer: string;
  nonce: string;
  amountAtomic: bigint;
  endpoint: string;
  resource: string;
  status: PaymentStatus;
  settleMode: SettleMode;
  /** Full x402 PaymentPayload / PaymentRequirements, kept so settlement survives restarts. */
  payload: unknown;
  requirements: unknown;
  validBefore: Date;
  fxRate: number;
  fxSource: string;
  attempts: number;
  nextAttemptAt: Date;
  txHash: string | null;
  error: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export type NewPayment = Pick<
  PaymentRow,
  "id" | "network" | "payer" | "nonce" | "amountAtomic" | "endpoint" | "resource" | "payload" | "requirements" | "validBefore" | "fxRate" | "fxSource"
> & {
  /** When the settlement worker may first pick this row up (lets the request path settle/cancel first). */
  nextAttemptAt: Date;
  /** Default "async" (conservative: counts as exposure while unsettled). */
  settleMode?: SettleMode;
};

/** Caps on value served against unsettled payments, across every replica. */
export interface ExposureCaps {
  totalAtomic: bigint;
  perPayerAtomic: bigint;
}

/**
 * What a served-but-unpaid payment costs its payer (async, then failed for good). It keeps counting
 * against the caps for holdMs, so a failure can't free the cap for the next try, and its payer is
 * admitted only as sync for demoteMs. Both are measured from the payment's created_at.
 */
export interface FailurePolicy {
  holdMs: number;
  demoteMs: number;
}

export interface AdmitOptions {
  /** The caller would settle asynchronously if the caps allow it. false: always admit as sync. */
  wantAsync: boolean;
  caps: ExposureCaps;
  failures: FailurePolicy;
  /** Admission time; the hold and demotion windows end relative to it. */
  now: Date;
  /** next_attempt_at for each outcome: async waits for the handler; sync keeps the worker away while settling inline. */
  asyncAttemptAt: Date;
  syncAttemptAt: Date;
}

/** Why a payment that could have been async was admitted as sync. */
export type SyncReason = "cap" | "demoted";
export type Admission = { result: "duplicate" } | { result: "inserted"; mode: SettleMode; syncReason?: SyncReason };

export interface ExposureSnapshot {
  totalAtomic: bigint;
  /** Payers with open exposure. */
  payers: number;
}

export interface CreditAccount {
  id: string;
  company: string;
  email: string;
  country: string;
  taxId: string | null;
  balanceMicros: number;
  status: "active" | "suspended";
  createdAt: Date;
}

/** A person who signs in to manage one credit account (the browser side of the credits rail). */
export interface CustomerUser {
  id: string;
  accountId: string;
  email: string;
  passwordHash: string;
  failedLogins: number;
  lockedUntil: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface ApiKeyInfo {
  id: string;
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface NewAccount {
  company: string;
  email: string;
  country: string;
  taxId: string | null;
}

export interface UsageRow {
  endpoint: string;
  micros: number;
  at: Date;
}

export interface PolicyEventRow {
  accountId: string;
  event: unknown;
  receivedAt: Date;
}

/** A prepaid x402 session (migration 006). Amounts in USDC atomic units; GBP in micros. */
export interface SessionRow {
  /** The settled payment that bought it: also the session id. */
  paymentId: string;
  payer: string;
  amountAtomic: bigint;
  /** Handed out to replicas as leases, net of what they returned. Never more than amountAtomic. */
  reservedAtomic: bigint;
  /** Reported as spent. Never more than reservedAtomic. */
  spentAtomic: bigint;
  /** The liability booked at purchase. */
  netGbpMicros: number;
  releasedGbpMicros: number;
  createdAt: Date;
  expiresAt: Date;
  closedAt: Date | null;
}

export type ReserveResult =
  | { ok: true; grantedAtomic: bigint; session: SessionRow }
  | { ok: false; reason: "unknown" | "not_a_session" | "not_settled" | "expired" | "closed" | "exhausted" };

export interface SessionUsage {
  /** Spent since the last report, by resource id. */
  byResource: ReadonlyMap<string, bigint>;
  /** Leased but unspent, handed back (on drain or expiry). */
  returnedAtomic: bigint;
}

export interface Store {
  ping(): Promise<boolean>;
  close(): Promise<void>;

  // x402 payments
  insertPayment(p: NewPayment): Promise<"inserted" | "duplicate">;
  getPayment(id: string): Promise<PaymentRow | null>;
  /**
   * Claims due 'verified' payments for settlement by pushing next_attempt_at forward by leaseMs.
   * Safe across replicas (FOR UPDATE SKIP LOCKED): a row is only ever in flight on one worker.
   */
  claimDuePayments(now: Date, limit: number, leaseMs: number): Promise<PaymentRow[]>;
  /** Marks settled and appends the revenue journal in one transaction. */
  settlePayment(id: string, txHash: string | null, journal: JournalInput): Promise<void>;
  /** final=false schedules a retry at nextAttemptAt. */
  failPayment(id: string, error: string, final: boolean, nextAttemptAt?: Date): Promise<void>;
  cancelPayment(id: string, reason: string): Promise<void>;
  /**
   * Newest first, ordered by (created_at, id). Keyset pagination: pass the last row's id as `before`
   * for the next page (stable under concurrent inserts, unlike offsets). The comparison uses the
   * row's stored timestamp, so sub-millisecond precision is never lost in a cursor.
   */
  listPayments(opts: { status?: PaymentStatus; limit: number; before?: string }): Promise<PaymentRow[]>;
  /**
   * Inserts a verified payment and decides its settle mode in one atomic step: async only if the
   * global and per-payer exposure (summed over every replica's unsettled async payments) stay within
   * the caps; otherwise sync. Concurrent admissions cannot jointly exceed a cap.
   */
  admitPayment(p: Omit<NewPayment, "nextAttemptAt" | "settleMode">, o: AdmitOptions): Promise<Admission>;
  /** Current exposure: unsettled payments that were served before settlement. */
  exposure(): Promise<ExposureSnapshot>;

  // Fiat credits
  createAccount(a: NewAccount, keyHash: string, keyPrefix: string): Promise<CreditAccount>;
  accountByKeyHash(hash: string): Promise<CreditAccount | null>;
  getAccount(id: string): Promise<CreditAccount | null>;
  /** Atomic conditional debit + usage journal. ok=false (no write) if balance is insufficient. */
  debit(accountId: string, micros: number, endpoint: string, journal: JournalInput): Promise<{ ok: boolean; balanceMicros: number }>;
  refund(accountId: string, micros: number, journal: JournalInput): Promise<void>;
  /** Idempotent on ref (Stripe checkout session id / bank reference). */
  applyTopUp(t: { ref: string; accountId: string; netMicros: number; vatMicros: number }, journal: JournalInput): Promise<"applied" | "duplicate">;
  usage(accountId: string, limit: number): Promise<UsageRow[]>;

  // Customer sign-in (browser account pages)
  /** Creates the credit account, its first API key and its user in one transaction. */
  createCustomer(a: NewAccount, user: { email: string; passwordHash: string }, key: { hash: string; prefix: string }): Promise<{ account: CreditAccount; user: CustomerUser } | "email_taken">;
  /** Case-insensitive. */
  customerByEmail(email: string): Promise<CustomerUser | null>;
  /** Counts a failed sign-in; at maxFailures the user is locked until now + lockMs and the count restarts. */
  recordLoginFailure(userId: string, now: Date, maxFailures: number, lockMs: number): Promise<void>;
  recordLoginSuccess(userId: string, now: Date): Promise<void>;
  createWebSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  /** The signed-in user and their account, if the session exists, is not revoked and has not expired. */
  webSession(tokenHash: string, now: Date): Promise<{ user: CustomerUser; account: CreditAccount } | null>;
  revokeWebSession(tokenHash: string): Promise<void>;
  listApiKeys(accountId: string): Promise<ApiKeyInfo[]>;
  addApiKey(accountId: string, hash: string, prefix: string): Promise<ApiKeyInfo>;
  /** False if the key isn't this account's or was already revoked. */
  revokeApiKey(accountId: string, keyId: string): Promise<boolean>;

  // x402 sessions
  /**
   * Leases up to `chunkAtomic` of a session's unreserved balance to the caller, atomically across
   * replicas. Opens the session on first use from its settled payment (expiring ttlMs after
   * settlement). Never grants past the amount or after expiry.
   */
  reserveSession(paymentId: string, chunkAtomic: bigint, now: Date, ttlMs: number): Promise<ReserveResult>;
  /**
   * Records spending and returned leases, and in the same transaction moves the matching share of
   * the GBP liability into each resource's product revenue. A closed session still records the
   * spend but books nothing (its remainder already went to breakage).
   */
  recordSessionUsage(paymentId: string, usage: SessionUsage, occurredAt: Date): Promise<void>;
  /** Closes sessions expired more than graceMs ago and books their unreleased liability as breakage. */
  closeExpiredSessions(now: Date, graceMs: number): Promise<number>;
  getSession(paymentId: string): Promise<SessionRow | null>;

  // Ledger
  journal(range?: { from?: Date; to?: Date }): Promise<JournalEntry[]>;

  // Control plane
  addPolicyEvents(accountId: string, events: unknown[]): Promise<void>;
  listPolicyEvents(limit: number): Promise<PolicyEventRow[]>;

  // Operator-maintained reference data (e.g. Panama draught limit)
  setCondition(id: string, value: unknown, source: string): Promise<void>;
  getCondition(id: string): Promise<{ value: unknown; source: string; updatedAt: Date } | null>;
}
