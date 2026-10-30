import type { JournalEntry, JournalInput } from "../ledger/journal";

export type PaymentStatus = "verified" | "settled" | "failed" | "cancelled";

export interface PaymentRow {
  id: string;
  network: string;
  payer: string;
  nonce: string;
  amountAtomic: bigint;
  endpoint: string;
  resource: string;
  status: PaymentStatus;
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
};

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
  unsettledByPayer(): Promise<{ payer: string; atomic: bigint }[]>;

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
