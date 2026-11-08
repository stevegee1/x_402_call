import { serve } from "@hono/node-server";
import { CARBON_INTENSITY, EnvCache, EnvFollower, PgEnvStore } from "@mx/env";
import { createApp } from "./app";
import { isMainnet, loadConfig, settleConcurrency } from "./config";
import type { AppDeps } from "./context";
import { StripeCheckout } from "./credits/checkout";
import { CustomerAccounts } from "./customers/service";
import { CreditsService } from "./credits/service";
import { CoinbaseFx, FixedFx } from "./ledger/fx";
import { createLogger } from "./logger";
import { Metrics } from "./metrics";
import { createPublicClient, getAddress, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createAgentRegistry } from "./identity/erc8004";
import { agentRegistryId, ERC8004_REGISTRIES } from "./identity/registries";
import { TierResolver } from "./identity/tiers";
import { exposureCaps, failurePolicy, usdToAtomic } from "./payments/exposure";
import { FailoverFacilitator } from "./payments/facilitator";
import { createFacilitatorClients } from "./payments/facilitator-clients";
import { createAuthorizationChecker } from "./payments/onchain";
import { SanctionsService } from "./payments/sanctions";
import { Settler } from "./payments/settlement";
import { createResourceServer, RequirementsCache } from "./payments/x402";
import { Catalog } from "./platform/catalog";
import type { Product } from "./platform/product";
import { natsFeed, simulatorFeed } from "./products/maritime/feed";
import { GridFeed } from "./products/grid/feed";
import { GridHistory } from "./products/grid/history";
import { GridUpdates } from "./products/grid/updates";
import { StoreGridSource } from "./products/grid/store-source";
import { GridProduct } from "./products/grid";
import { NesoGridSource } from "./products/grid/source";
import { MaritimeProduct } from "./products/maritime";
import { SnapshotEngine } from "./products/maritime/snapshot/engine";
import { WorldState } from "./products/maritime/snapshot/state";
import { migrate } from "./store/migrate";
import { MemoryStore } from "./store/memory";
import { SessionManager } from "./sessions/manager";
import { SessionsProduct } from "./sessions/product";
import { usdToUsdcAtomic } from "@mx/shared";
import { PgStore } from "./store/pg";
import type { Store } from "./store/types";

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const metrics = new Metrics();

if (isMainnet(cfg) && cfg.DATA_SOURCE === "simulator") log.warn("mainnet with simulator data: all paid endpoints will refuse to charge");

// Persistence
let store: Store;
if (cfg.DATABASE_URL) {
  await migrate(cfg.DATABASE_URL, (m) => log.info(m));
  store = new PgStore(cfg.DATABASE_URL);
} else {
  log.warn("DATABASE_URL not set: using in-memory store (development only, not durable)");
  store = new MemoryStore();
}

// Products. Each owns its data plane; the catalog validates them all before we serve anything.
const world = new WorldState();
const feed = cfg.DATA_SOURCE === "nats" ? natsFeed(cfg.NATS_URL, world, log, metrics) : simulatorFeed(world);
const engine = new SnapshotEngine(world, cfg.SNAPSHOT_INTERVAL_MS);
const maritime = new MaritimeProduct({ engine, store, feedConnected: feed.connected, snapshotIntervalMs: cfg.SNAPSHOT_INTERVAL_MS });
await maritime.load();
engine.start();
const products: Product[] = [maritime];
let gridFeed: GridFeed | undefined;
let envStore: PgEnvStore | undefined;
let envFollower: EnvFollower | undefined;
if (cfg.GRID_ENABLED && cfg.GRID_SOURCE === "store") {
  // Versions written by ingest-env, followed in memory: the live view updates the moment a new
  // version commits (LISTEN/NOTIFY), and history reads for the recent window never touch Postgres.
  envStore = new PgEnvStore(cfg.DATABASE_URL!);
  if (!(await envStore.schemaReady())) throw new Error("env tables missing after migrations");
  const cache = new EnvCache(envStore, { dataset: CARBON_INTENSITY.id, regions: CARBON_INTENSITY.regions, windowMs: cfg.GRID_HISTORY_MEMORY_DAYS * 86_400_000 });
  envFollower = new EnvFollower(envStore, cache, log);
  await envFollower.start();
  const follower = envFollower;
  gridFeed = new GridFeed(new StoreGridSource(cache, { lastRefreshAt: () => cache.lastRefreshAt, ingestLastSuccessAt: () => follower.ingestLastSuccessAt }), log, cfg.GRID_POLL_MS);
  const feedRef = gridFeed;
  // After every follower step: a new version reaches the live endpoints at once, and so does
  // ingest recovering (which changes freshness without changing values).
  // Push needs sessions (streams are paid per event from one). Subscribers hear about a version
  // only after the feed has taken it in.
  const updates = cfg.SESSIONS_ENABLED ? new GridUpdates() : undefined;
  let streamedPosition = cache.position;
  envFollower.onUpdate(() => {
    void feedRef.poll().then(() => {
      if (updates && cache.position !== streamedPosition) {
        streamedPosition = cache.position;
        updates.publish();
      }
    });
  });
  await gridFeed.poll();
  gridFeed.start();
  products.push(new GridProduct(gridFeed, Date.now, new GridHistory(cache, envStore), updates));
  log.info({ versions: cache.size, windowDays: cfg.GRID_HISTORY_MEMORY_DAYS }, "grid reading from the version store");
} else if (cfg.GRID_ENABLED) {
  gridFeed = new GridFeed(new NesoGridSource(cfg.GRID_SOURCE_URL), log, cfg.GRID_POLL_MS);
  await gridFeed.poll(); // serve with data from the first request, or report stale (never charge)
  gridFeed.start();
  products.push(new GridProduct(gridFeed));
}
// x402 sessions: a platform product (buy) plus a billing rail (spend from memory).
let sessions: SessionManager | undefined;
if (cfg.SESSIONS_ENABLED) {
  sessions = new SessionManager(
    store,
    {
      secret: cfg.SESSION_SECRET!,
      ttlMs: cfg.SESSION_TTL_MINUTES * 60_000,
      leaseAtomic: usdToUsdcAtomic(cfg.SESSION_LEASE_USD.toFixed(6)),
      flushMs: cfg.SESSION_FLUSH_MS,
      graceMs: cfg.SESSION_CLOSE_GRACE_MS,
    },
    log,
    metrics,
  );
  sessions.start();
  products.push(new SessionsProduct(sessions, store));
}
const catalog = new Catalog(products);

// Payments
const { primary, fallback } = createFacilitatorClients(cfg);
const facilitator = new FailoverFacilitator(primary, fallback, (name, state) => {
  metrics.set("breaker_open", state === "open" ? 1 : 0, { breaker: name });
  log.warn({ breaker: name, state }, "circuit breaker state change");
});
facilitator.limitSettles(settleConcurrency(cfg), (queued) => metrics.inc("x402_settle_queued_total", { queued: queued > 4 ? "5+" : String(queued) }));
const resourceServer = createResourceServer(facilitator, cfg.X402_NETWORK);
await resourceServer.initialize();
const requirements = new RequirementsCache(resourceServer, { payTo: cfg.PAY_TO, network: cfg.X402_NETWORK, maxTimeoutSeconds: cfg.MAX_TIMEOUT_SECONDS });
await requirements.warm(catalog.resources);

const checker = cfg.BASE_RPC_URL ? createAuthorizationChecker(cfg.X402_NETWORK, cfg.BASE_RPC_URL) : undefined;
if (!checker) log.warn("BASE_RPC_URL not set: indeterminate settlements cannot be reconciled on-chain");
const settler = new Settler(store, resourceServer, log, metrics, checker);
settler.start();

// ERC-8004 buyer identity (loosen-only tiers) and our own seller identity.
const registries = {
  identity: getAddress(cfg.ERC8004_IDENTITY_REGISTRY ?? ERC8004_REGISTRIES[cfg.X402_NETWORK]!.identity),
  reputation: getAddress(cfg.ERC8004_REPUTATION_REGISTRY ?? ERC8004_REGISTRIES[cfg.X402_NETWORK]!.reputation),
};
let identity: TierResolver | undefined;
if (cfg.ERC8004_ENABLED) {
  const client = createPublicClient({ chain: isMainnet(cfg) ? base : baseSepolia, transport: http(cfg.BASE_RPC_URL, { timeout: cfg.ERC8004_LOOKUP_TIMEOUT_MS }) });
  const caps = exposureCaps(cfg);
  identity = new TierResolver(
    createAgentRegistry(client, registries),
    {
      network: cfg.X402_NETWORK,
      identityRegistry: registries.identity,
      reviewers: cfg.ERC8004_TRUSTED_REVIEWERS.map((a) => getAddress(a)),
      tag: cfg.ERC8004_REPUTATION_TAG,
      minFeedback: cfg.ERC8004_TRUSTED_MIN_FEEDBACK,
      minScore: cfg.ERC8004_TRUSTED_MIN_SCORE,
      timeoutMs: cfg.ERC8004_LOOKUP_TIMEOUT_MS,
      totalCapAtomic: caps.totalAtomic,
      perPayerCapAtomic: {
        unknown: caps.perPayerAtomic,
        identified: usdToAtomic(cfg.EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD),
        trusted: usdToAtomic(cfg.EXPOSURE_CAP_PER_PAYER_TRUSTED_USD),
      },
    },
    (reason) => metrics.inc("erc8004_lookups_total", { reason }),
  );
  log.info({ registries, reviewers: cfg.ERC8004_TRUSTED_REVIEWERS.length }, "ERC-8004 buyer tiers enabled");
}
const sellerIdentity = cfg.SELLER_AGENT_ID ? { agentRegistry: agentRegistryId(cfg.X402_NETWORK, registries.identity), agentId: cfg.SELLER_AGENT_ID } : undefined;

const sanctions = new SanctionsService({
  denylistPath: cfg.SANCTIONS_DENYLIST_PATH,
  chainalysisApiKey: cfg.CHAINALYSIS_API_KEY,
  failClosed: cfg.SANCTIONS_FAIL_CLOSED,
  onError: (e) => {
    metrics.inc("sanctions_screening_errors_total");
    log.warn({ err: e }, "sanctions screening unavailable");
  },
});

// Fiat credits
const checkout = cfg.STRIPE_SECRET_KEY && cfg.STRIPE_WEBHOOK_SECRET ? new StripeCheckout(cfg.STRIPE_SECRET_KEY, cfg.STRIPE_WEBHOOK_SECRET) : undefined;
if (!checkout) log.warn("Stripe not configured: card top-ups disabled (manual/bank top-ups still available)");
const credits = new CreditsService(store, checkout, { publicBaseUrl: cfg.PUBLIC_BASE_URL, keyEnv: isMainnet(cfg) ? "live" : "test" });
const customers = new CustomerAccounts(store, credits, isMainnet(cfg) ? "live" : "test");

const deps: AppDeps = {
  cfg,
  log,
  metrics,
  store,
  catalog,
  credits,
  customers,
  resourceServer,
  requirements,
  facilitator,
  settler,
  exposureCaps: exposureCaps(cfg),
  failurePolicy: failurePolicy(cfg),
  identity,
  sellerIdentity,
  sanctions,
  fx: cfg.FX_PROVIDER === "fixed" ? new FixedFx(cfg.FX_FALLBACK_USDC_GBP) : new CoinbaseFx(cfg.FX_FALLBACK_USDC_GBP),
  sessions,
  startedAt: Date.now(),
};

const server = serve({ fetch: createApp(deps).fetch, port: cfg.PORT }, (info) =>
  log.info({ port: info.port, network: cfg.X402_NETWORK, products: catalog.products.map((p) => p.id), dataSource: cfg.DATA_SOURCE, settlement: cfg.SETTLEMENT_MODE }, "gateway listening"),
);

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  server.close();
  engine.stop();
  gridFeed?.stop();
  await envFollower?.stop();
  settler.stop();
  await sessions?.stop(); // report spend and hand leases back before the store closes
  // Give in-flight settlements a moment; anything unfinished is re-claimed after its lease expires.
  await new Promise((r) => setTimeout(r, 1_000));
  await feed.close();
  await store.close();
  await envStore?.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
