import type { Config } from "../config";
import type { ExposureCaps } from "../store/types";

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
