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

export interface AdmitOptions {
  /** The caller would settle asynchronously if the caps allow it. false: always admit as sync. */
  wantAsync: boolean;
  caps: ExposureCaps;
  /** next_attempt_at for each outcome: async waits for the handler; sync keeps the worker away while settling inline. */
  asyncAttemptAt: Date;
  syncAttemptAt: Date;
}

export type Admission = { result: "duplicate" } | { result: "inserted"; mode: SettleMode };

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
  listPayments(opts: { status?: PaymentStatus; limit: number }): Promise<PaymentRow[]>;
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

  // Ledger
  journal(range?: { from?: Date; to?: Date }): Promise<JournalEntry[]>;

  // Control plane
  addPolicyEvents(accountId: string, events: unknown[]): Promise<void>;
  listPolicyEvents(limit: number): Promise<PolicyEventRow[]>;

  // Operator-maintained reference data (e.g. Panama draught limit)
  setCondition(id: string, value: unknown, source: string): Promise<void>;
  getCondition(id: string): Promise<{ value: unknown; source: string; updatedAt: Date } | null>;
}
