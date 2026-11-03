import type { x402ResourceServer } from "@x402/core/server";
import type { Config } from "./config";
import type { CreditsService } from "./credits/service";
import type { FxService } from "./ledger/fx";
import type { Logger } from "./logger";
import type { Metrics } from "./metrics";
import type { ExposureCaps } from "./store/types";
import type { FailoverFacilitator } from "./payments/facilitator";
import type { SanctionsScreen } from "./payments/sanctions";
import type { Settler } from "./payments/settlement";
import type { RequirementsCache } from "./payments/x402";
import type { Catalog } from "./platform/catalog";
import type { Resolution } from "./platform/product";
import type { CreditAccount, Store } from "./store/types";

export interface AppDeps {
  cfg: Config;
  log: Logger;
  metrics: Metrics;
  store: Store;
  /** The products this gateway hosts (maritime, …). */
  catalog: Catalog;
  credits: CreditsService;
  resourceServer: x402ResourceServer;
  requirements: RequirementsCache;
  facilitator: FailoverFacilitator;
  settler: Settler;
  /** Global caps on served-but-unsettled value; enforced by Store.admitPayment. */
  exposureCaps: ExposureCaps;
  sanctions: SanctionsScreen;
  fx: FxService;
  startedAt: number;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    /** Set by billing after the product resolved the request: scope + product-owned state. */
    resolution: Resolution<unknown>;
    account: CreditAccount;
  };
};
