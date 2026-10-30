import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { x402SettlementJournal } from "../ledger/journal";
import type { Logger } from "../logger";
import type { Metrics } from "../metrics";
import type { PaymentRow, Store } from "../store/types";
import type { ExposureTracker } from "./exposure";
import type { AuthorizationChecker } from "./onchain";

const MAX_ATTEMPTS = 6;
const LEASE_MS = 60_000;
/** Facilitator error reasons that will never succeed on retry. */
const FINAL_REASON = /insufficient|invalid|signature|expired|value|recipient|unsupported/i;

export type SettleOutcome = { ok: true; response: SettleResponse | null } | { ok: false; reason: string; final: boolean };

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
    private readonly exposure: ExposureTracker,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly checker?: AuthorizationChecker,
    private readonly pollMs = 500,
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

  async settleNow(row: PaymentRow): Promise<SettleOutcome> {
    const t0 = Date.now();
    const auth = authOf(row);
    const asset = (row.requirements as PaymentRequirements).asset;

    if (Date.now() > row.validBefore.getTime()) {
      // The authorization can no longer be submitted; it either settled earlier (indeterminate) or never will.
      if (auth && (await this.consumedOnChain(asset, auth))) return this.markSettled(row, null);
      return this.markFailed(row, "authorization_expired", true);
    }

    let res: SettleResponse;
    try {
      res = await this.server.settlePayment(row.payload as PaymentPayload, row.requirements as PaymentRequirements);
    } catch (e) {
      // Timeout / transport error: outcome unknown. Check chain before deciding.
      if (auth && (await this.consumedOnChain(asset, auth))) return this.markSettled(row, null);
      return this.markFailed(row, `indeterminate: ${(e as Error).message}`, false);
    } finally {
      this.metrics.set("x402_settle_last_ms", Date.now() - t0);
    }

    if (res.success) return this.markSettled(row, res);

    const reason = res.errorReason ?? "unknown";
    // A "nonce already used" style failure may mean a previous attempt succeeded.
    if (/nonce|used|already/i.test(reason) && auth && (await this.consumedOnChain(asset, auth))) return this.markSettled(row, null);
    return this.markFailed(row, reason, FINAL_REASON.test(reason));
  }

  private async consumedOnChain(asset: string, auth: Authorization): Promise<boolean> {
    if (!this.checker) return false;
    try {
      return await this.checker.isUsed(asset, auth.from, auth.nonce);
    } catch (e) {
      this.log.warn({ err: e }, "on-chain authorization check failed");
      return false;
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
    this.exposure.release(row.payer, row.amountAtomic);
    this.metrics.inc("x402_settlements_total", { result: "success" });
    this.metrics.inc("x402_revenue_usdc_atomic_total", {}, Number(row.amountAtomic));
    this.log.info({ paymentId: row.id, tx: res?.transaction ?? null }, "payment settled");
    return { ok: true, response: res };
  }

  private async markFailed(row: PaymentRow, reason: string, finalHint: boolean): Promise<SettleOutcome> {
    const final = finalHint || row.attempts + 1 >= MAX_ATTEMPTS;
    const backoffMs = Math.min(30_000, 1_000 * 2 ** row.attempts);
    await this.store.failPayment(row.id, reason, final, final ? undefined : new Date(Date.now() + backoffMs));
    if (final) {
      this.exposure.release(row.payer, row.amountAtomic);
      this.metrics.inc("x402_settlements_total", { result: "failed" });
      this.metrics.inc("x402_settlement_failed_usdc_atomic_total", {}, Number(row.amountAtomic));
      this.log.warn({ paymentId: row.id, reason }, "payment settlement failed permanently");
    } else {
      this.metrics.inc("x402_settlements_total", { result: "retry" });
    }
    return { ok: false, reason, final };
  }
}
