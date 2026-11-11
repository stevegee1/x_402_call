import { createPolicyClient, DEFAULT_BREAKERS, type Policy } from "@mx/policy-sdk";
import { zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { AgentRegistry } from "../../src/identity/erc8004";
import { ERC8004_REGISTRIES } from "../../src/identity/registries";
import { TierResolver } from "../../src/identity/tiers";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";

// In-process: real app, policy SDK and x402 signing; registry faked. Caps: unknown $0.11,
// identified $0.22, trusted $0.33 per payer, i.e. 3 / 6 / 9 concurrent $0.035 payments.
const NET = "eip155:84532";
const REG = ERC8004_REGISTRIES[NET]!.identity;
const REVIEWER = "0x00000000000000000000000000000000000000f1" as Address;
const VESSELS = `${BASE_URL}/v1/maritime/dover/vessels`;

const policy = (): Policy => ({
  agentId: "tier-test",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  dailyBudgetGbp: 5,
  allowedNetworks: [NET],
  allowedOrigins: [BASE_URL],
  breakers: { ...DEFAULT_BREAKERS, velocity: { maxPayments: 100, windowMs: 60_000 } },
});

class FakeRegistry implements AgentRegistry {
  wallets = new Map<bigint, Address>();
  rep = new Map<bigint, { count: number; score: number }>();
  failing = false;
  async agentWallet(id: bigint) {
    if (this.failing) throw new Error("rpc down");
    return this.wallets.get(id) ?? zeroAddress;
  }
  async reputation(id: bigint) {
    return this.rep.get(id) ?? { count: 0, score: 0 };
  }
}

async function setup(withIdentity = true) {
  const registry = new FakeRegistry();
  const identity = withIdentity
    ? new TierResolver(registry, {
        network: NET,
        identityRegistry: REG,
        reviewers: [REVIEWER],
        tag: "",
        minFeedback: 3,
        minScore: 80,
        timeoutMs: 200,
        totalCapAtomic: 25_000_000n,
        perPayerCapAtomic: { unknown: 110_000n, identified: 220_000n, trusted: 330_000n },
      })
    : undefined;
  const env = await createTestEnv(
    { EXPOSURE_CAP_PER_PAYER_USD: "0.11", EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD: "0.22", EXPOSURE_CAP_PER_PAYER_TRUSTED_USD: "0.33" },
    { identity, sellerIdentity: { agentRegistry: `${NET}:${REG}`, agentId: "7" } },
  );
  return { env, registry };
}

/** Pays `n` times in a row without settling in between; returns X-Settlement and X-Agent-Tier per call. */
async function payMany(env: TestEnv, signer: PrivateKeyAccount, n: number, agentId?: string) {
  const client = createPolicyClient({ policy: policy(), signer, agentId, fetch: env.fetch });
  const out: { settlement: string | null; tier: string | null }[] = [];
  for (let i = 0; i < n; i++) {
    const res = await client.fetch(VESSELS);
    expect(res.status).toBe(200);
    out.push({ settlement: res.headers.get("X-Settlement"), tier: res.headers.get("X-Agent-Tier") });
  }
  return out;
}
const pendingCount = (r: { settlement: string | null }[]) => r.filter((x) => x.settlement === "pending").length;

describe("ERC-8004 tiers in billing", () => {
  it("unknown buyers keep today's per-payer cap", async () => {
    const { env } = await setup();
    const r = await payMany(env, privateKeyToAccount(generatePrivateKey()), 4);
    expect(pendingCount(r)).toBe(3);
    expect(r[3]).toEqual({ settlement: "settled", tier: "unknown" });
  });

  it("a verified agent gets the identified cap; good reputation from our reviewers gets the trusted cap", async () => {
    const { env, registry } = await setup();
    const alice = privateKeyToAccount(generatePrivateKey());
    registry.wallets.set(42n, alice.address);
    const identified = await payMany(env, alice, 7, "42");
    expect(pendingCount(identified)).toBe(6);
    expect(new Set(identified.map((x) => x.tier))).toEqual(new Set(["identified"]));

    const { env: env2, registry: registry2 } = await setup();
    registry2.wallets.set(42n, alice.address);
    registry2.rep.set(42n, { count: 5, score: 92 });
    const trusted = await payMany(env2, alice, 10, `${NET}:${REG}:42`);
    expect(pendingCount(trusted)).toBe(9);
    expect(trusted[0]!.tier).toBe("trusted");
  });

  it("claiming another agent's identity changes nothing", async () => {
    const { env, registry } = await setup();
    registry.wallets.set(42n, privateKeyToAccount(generatePrivateKey()).address);
    registry.rep.set(42n, { count: 50, score: 100 });
    const r = await payMany(env, privateKeyToAccount(generatePrivateKey()), 4, "42");
    expect(pendingCount(r)).toBe(3);
    expect(r[0]!.tier).toBe("unknown");
  });

  it("a registry outage serves everyone as unknown, never fails the request", async () => {
    const { env, registry } = await setup();
    const alice = privateKeyToAccount(generatePrivateKey());
    registry.wallets.set(42n, alice.address);
    registry.failing = true;
    const r = await payMany(env, alice, 4, "42");
    expect(pendingCount(r)).toBe(3);
    expect(env.deps.metrics.get("paid_requests_total", { rail: "x402", resource: "maritime.vessels", mode: "async", tier: "unknown" })).toBe(3);
  });

  it("with ERC-8004 disabled the header is ignored", async () => {
    const { env } = await setup(false);
    const r = await payMany(env, privateKeyToAccount(generatePrivateKey()), 4, "42");
    expect(pendingCount(r)).toBe(3);
    expect(r[0]!.tier).toBe("unknown");
  });

  it("a tier never raises the global cap", async () => {
    const { env, registry } = await setup();
    const buyers = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()));
    buyers.forEach((b, i) => {
      registry.wallets.set(BigInt(i + 1), b.address);
      registry.rep.set(BigInt(i + 1), { count: 5, score: 99 });
    });
    env.deps.identity!.policy.totalCapAtomic = 0n; // nothing may be served unsettled, whatever the tier
    for (const [i, b] of buyers.entries()) {
      const r = await payMany(env, b, 1, String(i + 1));
      expect(r[0]).toEqual({ settlement: "settled", tier: "trusted" });
    }
  });

  it("advertises our seller identity and the buyer header", async () => {
    const { env } = await setup();
    const root = await (await env.fetch(`${BASE_URL}/`)).json();
    expect(root.identity).toEqual({ seller: { agent_registry: `${NET}:${REG}`, agent_id: "7" }, buyer: { header: "X-Agent-Id", agent_registry: `${NET}:${REG}` } });
    const challenge = await (await env.fetch(VESSELS)).json();
    expect(challenge.seller_identity).toEqual({ agent_registry: `${NET}:${REG}`, agent_id: "7" });
  });
});
