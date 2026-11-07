import type { x402ResourceServer } from "@x402/core/server";
import type { Config } from "./config";
import type { CreditsService } from "./credits/service";
import type { FxService } from "./ledger/fx";
import type { Logger } from "./logger";
import type { Metrics } from "./metrics";
import type { TierResolver } from "./identity/tiers";
import type { ExposureCaps, FailurePolicy } from "./store/types";
import type { FailoverFacilitator } from "./payments/facilitator";
import type { SanctionsScreen } from "./payments/sanctions";
import type { Settler } from "./payments/settlement";
import type { SessionManager } from "./sessions/manager";
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
  /** What a served-early payment that fails for good costs its payer; see payments/exposure.ts. */
  failurePolicy: FailurePolicy;
  /** ERC-8004 buyer tiers; undefined when ERC8004_ENABLED=false (every payer is "unknown"). */
  identity?: TierResolver;
  /** Our ERC-8004 seller identity, advertised to buyers. */
  sellerIdentity?: { agentRegistry: string; agentId: string };
  sanctions: SanctionsScreen;
  fx: FxService;
  /** x402 sessions; undefined when SESSIONS_ENABLED=false. */
  sessions?: SessionManager;
  startedAt: number;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    /** Set by billing after the product resolved the request: scope + product-owned state. */
    resolution: Resolution<unknown>;
    account: CreditAccount;
    /** Set by billing for x402 payments, before the handler runs. */
    payment: { id: string; payer: string };
  };
};
