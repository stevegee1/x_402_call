import { zeroAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config";
import type { AgentRegistry } from "../../src/identity/erc8004";
import { ERC8004_REGISTRIES } from "../../src/identity/registries";
import { parseAgentId, TierResolver, type TierPolicy } from "../../src/identity/tiers";

const NET = "eip155:84532";
const REG = ERC8004_REGISTRIES[NET]!.identity;
const PAYER = "0x00000000000000000000000000000000000000a1" as Address;
const REVIEWER = "0x00000000000000000000000000000000000000f1" as Address;

const policy = (over: Partial<TierPolicy> = {}): TierPolicy => ({
  network: NET,
  identityRegistry: REG,
  reviewers: [REVIEWER],
  tag: "",
  minFeedback: 3,
  minScore: 80,
  timeoutMs: 50,
  totalCapAtomic: 25_000_000n,
  perPayerCapAtomic: { unknown: 1_000_000n, identified: 2_000_000n, trusted: 5_000_000n },
  ...over,
});

function registry(wallets: Record<string, Address>, rep: { count: number; score: number } = { count: 0, score: 0 }) {
  return {
    agentWallet: vi.fn<AgentRegistry["agentWallet"]>(async (id) => wallets[id.toString()] ?? zeroAddress),
    reputation: vi.fn<AgentRegistry["reputation"]>(async () => rep),
  };
}

describe("parseAgentId", () => {
  it("accepts a decimal id and the ERC-8004 global form for our registry", () => {
    expect(parseAgentId("42", NET, REG)).toEqual({ agentId: 42n });
    expect(parseAgentId(` ${NET}:${REG}:42 `, NET, REG)).toEqual({ agentId: 42n });
    expect(parseAgentId(`${NET}:${REG.toLowerCase()}:7`, NET, REG)).toEqual({ agentId: 7n });
  });

  it("refuses another chain's or another registry's agents", () => {
    expect(parseAgentId(`eip155:8453:${REG}:42`, NET, REG)).toEqual({ error: "other_registry" });
    expect(parseAgentId(`${NET}:0x${"11".repeat(20)}:42`, NET, REG)).toEqual({ error: "other_registry" });
  });

  it.each(["", "abc", "-1", "1.5", "0x2a", `${NET}:${REG}`, "1".repeat(79)])("rejects %j", (v) => {
    expect(parseAgentId(v, NET, REG)).toEqual({ error: "malformed_agent_id" });
  });
});

describe("TierResolver", () => {
  it("unknown without a header, with no registry call", async () => {
    const reg = registry({});
    const r = new TierResolver(reg, policy());
    expect(await r.resolve(PAYER, undefined)).toEqual({ tier: "unknown", reason: "no_agent_id" });
    expect(reg.agentWallet).not.toHaveBeenCalled();
  });

  it("identified when the agent's verified wallet is the payer (case-insensitive)", async () => {
    const r = new TierResolver(registry({ "42": PAYER.toUpperCase().replace("0X", "0x") as Address }, { count: 1, score: 99 }), policy());
    expect(await r.resolve(PAYER, "42")).toEqual({ tier: "identified", reason: "verified_wallet", agentId: 42n });
  });

  it("trusted with enough good feedback from our reviewers; the summary is read with our filter", async () => {
    const reg = registry({ "42": PAYER }, { count: 3, score: 80 });
    const r = new TierResolver(reg, policy({ tag: "quality" }));
    expect(await r.resolve(PAYER, "42")).toMatchObject({ tier: "trusted" });
    expect(reg.reputation).toHaveBeenCalledWith(42n, [REVIEWER], "quality");
  });

  it.each([
    [{ count: 2, score: 100 }, "too few reviews"],
    [{ count: 10, score: 79.99 }, "score below the bar"],
    [{ count: 5, score: -20 }, "negative feedback"],
  ])("identified, not trusted, with %j (%s)", async (rep) => {
    const r = new TierResolver(registry({ "42": PAYER }, rep), policy());
    expect(await r.resolve(PAYER, "42")).toMatchObject({ tier: "identified" });
  });

  it("without configured reviewers nobody is trusted, and reputation is never read", async () => {
    const reg = registry({ "42": PAYER }, { count: 99, score: 100 });
    const r = new TierResolver(reg, policy({ reviewers: [] }));
    expect(await r.resolve(PAYER, "42")).toMatchObject({ tier: "identified" });
    expect(reg.reputation).not.toHaveBeenCalled();
  });

  it("claiming someone else's agent gets nothing", async () => {
    const r = new TierResolver(registry({ "42": "0x00000000000000000000000000000000000000b2" }, { count: 9, score: 100 }), policy());
    expect(await r.resolve(PAYER, "42")).toEqual({ tier: "unknown", reason: "wallet_mismatch", agentId: 42n });
  });

  it("an unset or transfer-cleared wallet (zero address) never matches", async () => {
    const r = new TierResolver(registry({ "42": zeroAddress }), policy());
    expect(await r.resolve(zeroAddress, "42")).toMatchObject({ tier: "unknown", reason: "wallet_mismatch" });
  });

  it("a registry error or timeout is unknown (loosen-only: failure never costs the buyer)", async () => {
    const failing = { agentWallet: async () => Promise.reject(new Error("rpc down")), reputation: async () => ({ count: 0, score: 0 }) };
    expect(await new TierResolver(failing, policy()).resolve(PAYER, "42")).toMatchObject({ tier: "unknown", reason: "lookup_failed" });
    const hanging = { agentWallet: () => new Promise<Address>(() => {}), reputation: async () => ({ count: 0, score: 0 }) };
    const t0 = Date.now();
    expect(await new TierResolver(hanging, policy({ timeoutMs: 30 })).resolve(PAYER, "42")).toMatchObject({ reason: "lookup_failed" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("caches per (agent, payer): positive 5 min, negative 1 min, errors 10 s", async () => {
    let now = 1_000_000;
    const reg = registry({ "42": PAYER });
    const seen: string[] = [];
    const r = new TierResolver(reg, policy({ reviewers: [] }), (x) => seen.push(x), () => now);
    await r.resolve(PAYER, "42");
    await r.resolve(PAYER, "42");
    expect(reg.agentWallet).toHaveBeenCalledTimes(1);
    now += 299_000;
    await r.resolve(PAYER, "42");
    expect(reg.agentWallet).toHaveBeenCalledTimes(1);
    now += 2_000;
    await r.resolve(PAYER, "42");
    expect(reg.agentWallet).toHaveBeenCalledTimes(2);

    const other = "0x00000000000000000000000000000000000000c3" as Address; // same agent, other payer: own entry
    await r.resolve(other, "42");
    expect(reg.agentWallet).toHaveBeenCalledTimes(3);
    now += 61_000;
    await r.resolve(other, "42");
    expect(reg.agentWallet).toHaveBeenCalledTimes(4);
    expect(seen).toEqual(["verified_wallet", "verified_wallet", "wallet_mismatch", "wallet_mismatch"]);

    let calls = 0;
    const flaky = { agentWallet: async () => (++calls === 1 ? Promise.reject(new Error("blip")) : PAYER), reputation: async () => ({ count: 0, score: 0 }) };
    const r2 = new TierResolver(flaky, policy({ reviewers: [] }), undefined, () => now);
    expect(await r2.resolve(PAYER, "42")).toMatchObject({ tier: "unknown" });
    now += 11_000;
    expect(await r2.resolve(PAYER, "42")).toMatchObject({ tier: "identified" });
  });

  it("caps: tiers change only the per-payer cap; the global cap is shared", () => {
    const r = new TierResolver(registry({}), policy());
    expect(r.capsFor("unknown")).toEqual({ totalAtomic: 25_000_000n, perPayerAtomic: 1_000_000n });
    expect(r.capsFor("trusted")).toEqual({ totalAtomic: 25_000_000n, perPayerAtomic: 5_000_000n });
  });
});

describe("ERC-8004 config", () => {
  const base = { PAY_TO: "0x00000000000000000000000000000000000000aa" };

  it("tier caps must only loosen: unknown <= identified <= trusted <= global", () => {
    expect(() => loadConfig({ ...base, EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD: "0.5" })).toThrow(/tiers only loosen/);
    expect(() => loadConfig({ ...base, EXPOSURE_CAP_PER_PAYER_TRUSTED_USD: "1.5" })).toThrow(/tiers only loosen/);
    expect(() => loadConfig({ ...base, EXPOSURE_CAP_USD: "4" })).toThrow(/tiers only loosen/);
    expect(() => loadConfig({ ...base, EXPOSURE_CAP_PER_PAYER_IDENTIFIED_USD: "1", EXPOSURE_CAP_PER_PAYER_TRUSTED_USD: "1" })).not.toThrow();
  });

  it("requires an RPC when enabled, and parses reviewers", () => {
    expect(() => loadConfig({ ...base, ERC8004_ENABLED: "true" })).toThrow(/BASE_RPC_URL/);
    const c = loadConfig({ ...base, ERC8004_ENABLED: "true", BASE_RPC_URL: "http://rpc.test", ERC8004_TRUSTED_REVIEWERS: `${REVIEWER}, ${PAYER}` });
    expect(c.ERC8004_TRUSTED_REVIEWERS).toEqual([REVIEWER, PAYER]);
    expect(() => loadConfig({ ...base, ERC8004_TRUSTED_REVIEWERS: "0x12" })).toThrow(/ERC8004_TRUSTED_REVIEWERS/);
    expect(() => loadConfig({ ...base, SELLER_AGENT_ID: "abc" })).toThrow(/SELLER_AGENT_ID/);
  });

  it("is off by default", () => {
    expect(loadConfig(base).ERC8004_ENABLED).toBe(false);
  });
});
