import type { x402ResourceServer } from "@x402/core/server";
import type { Config } from "./config";
import type { CreditsService } from "./credits/service";
import type { FxService } from "./ledger/fx";
import type { Logger } from "./logger";
import type { Metrics } from "./metrics";
import type { ExposureTracker } from "./payments/exposure";
import type { FailoverFacilitator } from "./payments/facilitator";
import type { SanctionsScreen } from "./payments/sanctions";
import type { Settler } from "./payments/settlement";
import type { RequirementsCache } from "./payments/x402";
import type { RegionSnapshot, SnapshotEngine } from "./snapshot/engine";
import type { CreditAccount, Store } from "./store/types";

export interface AppDeps {
  cfg: Config;
  log: Logger;
  metrics: Metrics;
  store: Store;
  engine: SnapshotEngine;
  credits: CreditsService;
  resourceServer: x402ResourceServer;
  requirements: RequirementsCache;
  facilitator: FailoverFacilitator;
  settler: Settler;
  exposure: ExposureTracker;
  sanctions: SanctionsScreen;
  fx: FxService;
  /** Health of the data feed connection (NATS); simulator mode is always true. */
  feedConnected: () => boolean;
  startedAt: number;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    snapshot: RegionSnapshot;
    account: CreditAccount;
  };
};
