import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { x402SettlementJournal } from "../ledger/journal";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { PaymentRow, Store } from "../store/types";
import type { AuthorizationChecker } from "./onchain";

const MAX_ATTEMPTS = 6;
const LEASE_MS = 60_000;
/**
 * Facilitator failures that are worth retrying: the transaction didn't make it (reverted, dropped,
 * nonce clash in the facilitator's wallet, RPC trouble) but the authorization is still good.
 * Checked before FINAL_REASON, because every x402 EVM error code starts with "invalid_" (e.g.
 * invalid_exact_evm_transaction_failed is transient). Retrying is always safe: the EIP-3009 nonce
 * is single-use on chain, so at most one attempt can move the funds.
 */
const TRANSIENT_REASON = /transaction_failed|simulation_failed|settlement_pending|invalid_transaction_state|broadcast_failed|timeout|timed out|unavailable|rate.?limit|internal|network error|ECONN|503|502|500/i;
/**
 * Failures where the transaction may have been broadcast and may still mine: the facilitator gave up
 * waiting for the receipt (@x402/evm answers `settlement_pending` with the tx hash), lost track of
 * it, or failed on its side mid-flight. Never "not charged" on these: only the chain can say so.
 */
const MAYBE_BROADCAST_REASON = /settlement_pending|invalid_transaction_state|timeout|timed out|unavailable|internal|network error|ECONN|50[234]/i;
/**
 * The facilitator says the authorization's nonce is spent: our transfer may have moved the money or
 * be in flight, so this is indeterminate, never "not charged". (A spent nonce alone does not prove we
 * were paid: the payer can also spend it with cancelAuthorization. Confirming a Transfer to payTo is
 * tracked separately; the reconciler flags a settled payment with no matching transfer.)
 */
const NONCE_SPENT_REASON = /nonce|already/i;
/** After validBefore, how long to keep asking the chain before concluding a payment never moved (RPC lag). */
export const EXPIRY_GRACE_MS = 120_000;

/** Facilitator error reasons that will never succeed on retry (bad payment, not a bad moment). */
const FINAL_REASON = /insufficient|invalid|signature|expired|valid_before|value|recipient|unsupported|mismatch|not_supported/i;

export const isFinalReason = (reason: string) => !TRANSIENT_REASON.test(reason) && FINAL_REASON.test(reason);

/** Inline retries for a sync settlement: short, jittered, so the buyer waits about a second at most. */
const INLINE_RETRY_MS = [300, 700];

export type SettleOutcome = { ok: true; response: SettleResponse | null } | { ok: false; reason: string; final: boolean; indeterminate?: boolean };

export interface SettleOptions {
  /** Retry transient facilitator failures in place (sync settlement on the request path). */
  inline?: boolean;
  /**
   * Sync only: when settlement can't complete now and the outcome is known (the facilitator said it
   * failed), fail the payment for good. The buyer is told they weren't charged, so the worker must
   * never settle it later. An indeterminate outcome (timeout) is still left to the worker and the
   * on-chain check.
   */
  finalizeOnFailure?: boolean;
}

interface Authorization {
  from: string;
  nonce: string;
}

const authOf = (row: PaymentRow): Authorization | undefined => (row.payload as { payload?: { authorization?: Authorization } }).payload?.authorization;

/**
 * Settles verified x402 payments. Used two ways:
 *  - settleNow(): inline on the request path (sync mode, or when the exposure cap is hit)
 *  - background loop: async mode; claims due rows with a lease so replicas never double-process.
 */
export class Settler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly server: x402ResourceServer,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly checker?: AuthorizationChecker,
    private readonly pollMs = 500,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.store.claimDuePayments(now, 20, LEASE_MS);
      await Promise.all(rows.map((r) => this.settleNow(r)));
    } catch (e) {
      this.log.error({ err: e }, "settlement tick failed");
    } finally {
      this.running = false;
    }
  }

  async settleNow(row: PaymentRow, opts: SettleOptions = {}): Promise<SettleOutcome> {
    const t0 = Date.now();
    const auth = authOf(row);
    const asset = (row.requirements as PaymentRequirements).asset;

    if (row.settleMode === "sync" && !row.armedAt && !opts.inline) {
      // The request path never handed this to the facilitator (it died first). The worker must not
      // submit it, whatever its clock says: confirm it on chain if someone else did, or wait out the
      // expiry grace and fail it ("not charged").
      const used = auth ? await this.consumedOnChain(asset, auth) : false;
      if (used === true) return this.markSettled(row, null);
      if (used === "unknown" || Date.now() < row.validBefore.getTime() + EXPIRY_GRACE_MS) {
        await this.store.failPayment(row.id, "never_submitted: awaiting expiry", false, new Date(row.validBefore.getTime() + EXPIRY_GRACE_MS + 5_000));
        return { ok: false, reason: "never_submitted", final: false, indeterminate: true };
      }
      return this.markFailed(row, "never_submitted", true);
    }
    if (Date.now() > row.validBefore.getTime()) {
      // The authorization can no longer be submitted; it either settled earlier (indeterminate) or never will.
      const used = auth ? await this.consumedOnChain(asset, auth) : false;
      if (used === true) return this.markSettled(row, null);
      // Can't read the chain, or it may lag a transaction mined just before expiry: never tell a
      // buyer "not charged" on a guess. Keep checking through the grace period.
      if (used === "unknown" || Date.now() < row.validBefore.getTime() + EXPIRY_GRACE_MS) return this.markFailed(row, "authorization_expired: awaiting chain confirmation", false, true);
      return this.markFailed(row, "authorization_expired", true);
    }

    let res: SettleResponse | undefined;
    let confirmedOnChain = false;
    /** Some attempt in this call may have put a transaction on the wire. */
    let maybeBroadcast = false;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.server.settlePayment(row.payload as PaymentPayload, row.requirements as PaymentRequirements);
      } catch (e) {
        this.metrics.set("x402_settle_last_ms", Date.now() - t0);
        // Timeout / transport error: outcome unknown. Check chain before deciding.
        if (auth && (await this.consumedOnChain(asset, auth)) === true) return this.markSettled(row, null);
        return this.markFailed(row, `indeterminate: ${(e as Error).message}`, false, true);
      }
      if (res.success) break;
      const reason = res.errorReason ?? "unknown";
      if (MAYBE_BROADCAST_REASON.test(reason) || NONCE_SPENT_REASON.test(reason) || (res.transaction && !/revert/i.test(reason))) maybeBroadcast = true;
      // A "nonce already used" style failure may mean a previous attempt succeeded.
      if (/nonce|used|already/i.test(reason) && auth) {
        const used = await this.consumedOnChain(asset, auth);
        if (used === true) {
          confirmedOnChain = true;
          break;
        }
        // "Already used" and the chain can't be read: an earlier attempt may have moved the funds.
        if (used === "unknown") return this.markFailed(row, `indeterminate: ${reason}`, false, true);
      }
      const delay = opts.inline && !isFinalReason(reason) ? INLINE_RETRY_MS[attempt] : undefined;
      if (delay === undefined || Date.now() + delay >= row.validBefore.getTime()) break;
      this.metrics.inc("x402_settle_inline_retries_total", { reason: reason.slice(0, 64) });
      this.log.info({ paymentId: row.id, reason, attempt: attempt + 1 }, "settlement failed transiently; retrying");
      await this.sleep(delay * (0.75 + Math.random() * 0.5));
    }
    this.metrics.set("x402_settle_last_ms", Date.now() - t0);

    if (res.success) return this.markSettled(row, res);
    if (confirmedOnChain) return this.markSettled(row, null);
    const reason = res.errorReason ?? "unknown";
    // It may have been broadcast and may still mine: indeterminate, whatever the caller asked for.
    // The worker and the chain check finish it; the buyer is told "pending", never "not charged".
    if (maybeBroadcast) {
      if (auth && (await this.consumedOnChain(asset, auth)) === true) return this.markSettled(row, null);
      return this.markFailed(row, `indeterminate: ${reason}`, false, true);
    }
    const final = opts.finalizeOnFailure || isFinalReason(reason) || row.attempts + 1 >= MAX_ATTEMPTS;
    // Before giving up for good on a failure that wasn't the payment's fault, make sure the funds
    // didn't move anyway (a facilitator can report failure for a transaction that later mined).
    if (final && !isFinalReason(reason) && auth) {
      const used = await this.consumedOnChain(asset, auth);
      if (used === true) return this.markSettled(row, null);
      if (used === "unknown") return this.markFailed(row, `indeterminate: ${reason}`, false, true);
    }
    return this.markFailed(row, reason, final);
  }

  /**
   * Whether the authorization's nonce is spent on chain. "unknown" when the chain can't be read: the
   * caller must then never conclude "failed, not charged". Without a checker (development only;
   * production config requires BASE_RPC_URL) the answer is false, as before.
   */
  private async consumedOnChain(asset: string, auth: Authorization): Promise<boolean | "unknown"> {
    if (!this.checker) return false;
    try {
      return await this.checker.isUsed(asset, auth.from, auth.nonce);
    } catch (e) {
      this.metrics.inc("x402_chain_check_failed_total");
      this.log.warn({ err: e }, "on-chain authorization check failed");
      return "unknown";
    }
  }

  private async markSettled(row: PaymentRow, res: SettleResponse | null): Promise<SettleOutcome> {
    const journal = x402SettlementJournal({
      paymentId: row.id,
      amountAtomic: row.amountAtomic,
      fxRate: row.fxRate,
      fxSource: row.fxSource,
      transaction: res?.transaction || null,
      payer: row.payer,
      network: row.network,
      endpoint: row.endpoint,
      occurredAt: new Date().toISOString(),
    });
    await this.store.settlePayment(row.id, res?.transaction || null, journal);
    this.metrics.inc("x402_settlements_total", { result: "success" });
    this.metrics.inc("x402_revenue_usdc_atomic_total", {}, Number(row.amountAtomic));
    this.log.info({ paymentId: row.id, tx: res?.transaction ?? null }, "payment settled");
    return { ok: true, response: res };
  }

  private async markFailed(row: PaymentRow, reason: string, finalHint: boolean, indeterminate = false): Promise<SettleOutcome> {
    // An indeterminate outcome is never written off by the attempt cap: it may have moved the funds.
    // It is bounded by validBefore instead, after which the chain check gives a definite answer.
    const final = finalHint || (!indeterminate && row.attempts + 1 >= MAX_ATTEMPTS);
    const backoffMs = Math.min(30_000, 1_000 * 2 ** row.attempts);
    await this.store.failPayment(row.id, reason, final, final ? undefined : new Date(Date.now() + backoffMs));
    if (final) {
      this.metrics.inc("x402_settlements_total", { result: "failed" });
      this.metrics.inc("x402_settlement_failed_usdc_atomic_total", {}, Number(row.amountAtomic));
      this.log.warn({ paymentId: row.id, reason }, "payment settlement failed permanently");
    } else {
      this.metrics.inc("x402_settlements_total", { result: "retry" });
    }
    return { ok: false, reason, final, ...(indeterminate ? { indeterminate } : {}) };
  }
}
