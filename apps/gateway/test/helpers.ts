import { randomBytes } from "node:crypto";
import { TrafficSimulator } from "@mx/ais";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { verifyTypedData, type Address, type Hex } from "viem";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import type { AppDeps } from "../src/context";
import type { CheckoutGateway, CheckoutRequest, WebhookResult } from "../src/credits/checkout";
import { CreditsService } from "../src/credits/service";
import { FixedFx } from "../src/ledger/fx";
import { createLogger } from "../src/logger";
import { Metrics } from "../src/metrics";
import { exposureCaps, failurePolicy } from "../src/payments/exposure";
import { FailoverFacilitator } from "../src/payments/facilitator";
import { SanctionsService } from "../src/payments/sanctions";
import { Settler } from "../src/payments/settlement";
import { createResourceServer, RequirementsCache } from "../src/payments/x402";
import { Catalog } from "../src/platform/catalog";
import type { Product } from "../src/platform/product";
import { MaritimeProduct } from "../src/products/maritime";
import { SnapshotEngine } from "../src/products/maritime/snapshot/engine";
import { WorldState } from "../src/products/maritime/snapshot/state";
import { MemoryStore } from "../src/store/memory";

export const BASE_URL = "http://gw.test";
export const PAY_TO = "0x1111111111111111111111111111111111111111";
export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

/**
 * Facilitator double that performs real EIP-3009 signature verification (so client/server wire
 * compatibility is genuinely exercised) but fakes balances and on-chain settlement.
 */
export class FakeFacilitator implements FacilitatorClient {
  usedNonces = new Set<string>();
  settled: string[] = [];
  down = false;
  settleFails?: string;

  constructor(private readonly networks: string[]) {}

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: this.networks.map((network) => ({ x402Version: 2, scheme: "exact", network: network as `${string}:${string}` })), extensions: [], signers: {} };
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    if (this.down) throw new Error("ECONNREFUSED");
    const p = payload.payload as { signature: Hex; authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } };
    const a = p.authorization;
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: String(req.extra.name), version: String(req.extra.version), chainId: Number(req.network.split(":")[1]), verifyingContract: req.asset as Address },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: p.signature,
    });
    if (!ok) return { isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer: a.from };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase() || BigInt(a.value) < BigInt(req.amount)) return { isValid: false, invalidReason: "invalid_exact_evm_payload_value", payer: a.from };
    if (this.usedNonces.has(a.nonce)) return { isValid: false, invalidReason: "invalid_exact_evm_nonce_used", payer: a.from };
    return { isValid: true, payer: a.from };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    if (this.down) throw new Error("ECONNREFUSED");
    const a = (payload.payload as { authorization: { from: string; nonce: string } }).authorization;
    if (this.settleFails) return { success: false, errorReason: this.settleFails, transaction: "", network: req.network };
    if (this.usedNonces.has(a.nonce)) return { success: false, errorReason: "invalid_exact_evm_nonce_used", transaction: "", network: req.network };
    this.usedNonces.add(a.nonce);
    const tx = `0x${randomBytes(32).toString("hex")}`;
    this.settled.push(tx);
    return { success: true, transaction: tx, network: req.network, payer: a.from };
  }
}

export class FakeCheckout implements CheckoutGateway {
  created: CheckoutRequest[] = [];
  next?: WebhookResult;
  async createCheckout(r: CheckoutRequest) {
    this.created.push(r);
    return { id: `cs_test_${this.created.length}`, url: `https://checkout.stripe.test/${this.created.length}` };
  }
  async parseWebhook(_raw: string, sig: string): Promise<WebhookResult> {
    if (sig !== "valid") throw new Error("bad signature");
    return this.next ?? { type: "ignored", eventType: "none" };
  }
}

export interface TestEnv {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  store: MemoryStore;
  facilitator: FakeFacilitator;
  checkout: FakeCheckout;
  world: WorldState;
  engine: SnapshotEngine;
  maritime: MaritimeProduct;
  fetch: typeof fetch;
}

export interface TestEnvOptions {
  /** Extra products hosted next to maritime (kernel tests use a fake product). */
  products?: Product[];
  /** Maritime feed health (readiness tests). */
  feedConnected?: () => boolean;
  /** ERC-8004 tier resolver (identity tests). */
  identity?: AppDeps["identity"];
  sellerIdentity?: AppDeps["sellerIdentity"];
}

export async function createTestEnv(overrides: Partial<Record<keyof Config, string>> = {}, opts: TestEnvOptions = {}): Promise<TestEnv> {
  const cfg = loadConfig({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: BASE_URL,
    PAY_TO,
    ADMIN_TOKEN,
    LOG_LEVEL: "silent",
    FACILITATOR: "url",
    FACILITATOR_URL: "http://facilitator.test",
    ...overrides,
  });
  const log = createLogger("silent");
  const metrics = new Metrics();
  const store = new MemoryStore();
  const world = new WorldState();
  const sim = new TrafficSimulator({ vesselsPerRegion: 30, seed: 3, darkFraction: 0 });
  for (const e of sim.allStatics()) world.apply(e);
  for (let i = 0; i < 60; i++) for (const e of sim.step(1_000)) world.apply(e);
  const engine = new SnapshotEngine(world, cfg.SNAPSHOT_INTERVAL_MS);
  const maritime = new MaritimeProduct({ engine, store, feedConnected: opts.feedConnected ?? (() => true), snapshotIntervalMs: cfg.SNAPSHOT_INTERVAL_MS });
  const catalog = new Catalog([maritime, ...(opts.products ?? [])]);

  const facilitator = new FakeFacilitator([cfg.X402_NETWORK]);
  const failover = new FailoverFacilitator(facilitator, undefined, undefined, { windowMs: 30_000, minCalls: 3, failureRate: 0.5, slowCallMs: 5_000, openMs: 60_000 });
  const resourceServer = createResourceServer(failover, cfg.X402_NETWORK);
  await resourceServer.initialize();
  const requirements = new RequirementsCache(resourceServer, { payTo: PAY_TO, network: cfg.X402_NETWORK, maxTimeoutSeconds: cfg.MAX_TIMEOUT_SECONDS });
  const settler = new Settler(store, resourceServer, log, metrics);
  const checkout = new FakeCheckout();
  const sanctions = new SanctionsService({ failClosed: false });
  const deps: AppDeps = {
    cfg,
    log,
    metrics,
    store,
    catalog,
    credits: new CreditsService(store, checkout, { publicBaseUrl: BASE_URL, keyEnv: "test" }),
    resourceServer,
    requirements,
    facilitator: failover,
    settler,
    exposureCaps: exposureCaps(cfg),
    failurePolicy: failurePolicy(cfg),
    identity: opts.identity,
    sellerIdentity: opts.sellerIdentity,
    sanctions,
    fx: new FixedFx(0.8),
    startedAt: Date.now(),
  };
  const app = createApp(deps);
  const f = ((input: string | URL | Request, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
  return { app, deps, store, facilitator, checkout, world, engine, maritime, fetch: f };
}
