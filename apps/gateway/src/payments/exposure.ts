import type { Config } from "../config";
import type { ExposureCaps, FailurePolicy } from "../store/types";

/**
 * Exposure is value served against verified-but-unsettled payments: the credit risk of async
 * settlement. It is enforced globally, across replicas, at admission (Store.admitPayment): a
 * payment is served before settlement only if it keeps total and per-payer exposure within these
 * caps; otherwise the request settles synchronously. See db/migrations/003.
 */
export const usdToAtomic = (usd: number) => BigInt(Math.round(usd * 1_000_000));

export const exposureCaps = (cfg: Pick<Config, "EXPOSURE_CAP_USD" | "EXPOSURE_CAP_PER_PAYER_USD">): ExposureCaps => ({
  totalAtomic: usdToAtomic(cfg.EXPOSURE_CAP_USD),
  perPayerAtomic: usdToAtomic(cfg.EXPOSURE_CAP_PER_PAYER_USD),
});

/**
 * A served-early payment that then fails for good was data given away. It keeps counting against
 * the caps for the hold (so the cap bounds unpaid value per hold window, not just at one moment)
 * and its payer settles first for the demotion window (so one funded wallet can't repeat it).
 */
export const failurePolicy = (cfg: Pick<Config, "EXPOSURE_FAILED_HOLD_HOURS" | "ASYNC_DEMOTE_AFTER_FAILURE_DAYS">): FailurePolicy => ({
  holdMs: cfg.EXPOSURE_FAILED_HOLD_HOURS * 3_600_000,
  demoteMs: cfg.ASYNC_DEMOTE_AFTER_FAILURE_DAYS * 86_400_000,
});
