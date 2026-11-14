import { createPolicyClient, DEFAULT_BREAKERS } from "@mx/policy-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { AuthorizationChecker } from "../../src/payments/onchain";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";

/**
 * A settle whose outcome is unknown may have moved the buyer's money. Only the chain can say it
 * didn't, so an unreadable chain must never turn it into "failed, not charged" (I14): not on a
 * timeout, not on "nonce already used", not at the attempt cap, not at expiry.
 */

const URL_ = `${BASE_URL}/v1/maritime/dover/vessels`;
const buyer = (env: TestEnv) =>
  createPolicyClient({
    policy: { agentId: "t", maxPricePerRequestUsd: 0.1, dailyBudgetUsd: 5, dailyBudgetGbp: 5, allowedNetworks: ["eip155:84532"], allowedOrigins: [BASE_URL], breakers: DEFAULT_BREAKERS },
    signer: privateKeyToAccount(generatePrivateKey()),
    fetch: env.fetch,
    owedResend: { attempts: 0 },
  });

/** A chain view the test controls: down (throws), or the nonce's real state. */
function chain() {
  const c = { down: true, used: false, calls: 0 };
  const checker: AuthorizationChecker = {
    isUsed: async () => {
      c.calls++;
      if (c.down) throw new Error("rpc 429");
      return c.used;
    },
  };
  return { c, checker };
}

const statusOf = async (env: TestEnv) => (await env.store.listPayments({ limit: 1 }))[0]!;

describe("unknown settle outcomes and an unreadable chain", () => {
  it("a timeout with the chain unreadable stays retryable past the attempt cap, then settles when the chain says so", async () => {
    const { c, checker } = chain();
    const env = await createTestEnv({ SETTLEMENT_MODE: "sync" }, { checker });
    env.facilitator.settleThrows = "timeout";
    expect((await buyer(env).fetch(URL_)).status).toBe(503);
    for (let i = 1; i <= 10; i++) await env.deps.settler.tick(new Date(Date.now() + i * 60_000));
    const row = await statusOf(env);
    expect(row.status).toBe("verified"); // never written off: 11 attempts, all indeterminate
    expect(row.attempts).toBeGreaterThan(6);
    expect(env.deps.metrics.render()).toMatch(/x402_chain_check_failed_total \d+/);

    // The facilitator's transaction had in fact mined; the chain comes back and says so.
    c.down = false;
    c.used = true;
    await env.deps.settler.tick(new Date(Date.now() + 20 * 60_000));
    expect((await statusOf(env)).status).toBe("settled");
  });

  it("'nonce already used' with the chain unreadable is not a final failure", async () => {
    const { c, checker } = chain();
    const env = await createTestEnv({ SETTLEMENT_MODE: "sync" }, { checker });
    env.facilitator.settleThrows = "timeout";
    expect((await buyer(env).fetch(URL_)).status).toBe(503);
    env.facilitator.settleThrows = undefined;
    env.facilitator.settleFails = "invalid_exact_evm_nonce_already_used"; // an earlier attempt mined
    await env.deps.settler.tick(new Date(Date.now() + 60_000));
    expect((await statusOf(env)).status).toBe("verified");
    c.down = false;
    c.used = true;
    await env.deps.settler.tick(new Date(Date.now() + 120_000));
    expect((await statusOf(env)).status).toBe("settled");
  });

  it("an expired authorization is failed only once the chain confirms the nonce was never used", async () => {
    const { c, checker } = chain();
    const env = await createTestEnv({ SETTLEMENT_MODE: "sync", MAX_TIMEOUT_SECONDS: "60" }, { checker });
    env.facilitator.settleThrows = "timeout";
    expect((await buyer(env).fetch(URL_)).status).toBe(503);
    const late = Date.now() + 2 * 3_600_000;
    const realNow = Date.now;
    Date.now = () => late; // past validBefore
    try {
      await env.deps.settler.tick(new Date(late));
      expect((await statusOf(env)).status).toBe("verified"); // chain down: can't say "not charged"
      c.down = false;
      c.used = false;
      await env.deps.settler.tick(new Date(late + 3_600_000));
      expect((await statusOf(env)).status).toBe("failed"); // confirmed unused: truly not charged
    } finally {
      Date.now = realNow;
    }
  });

  it("just after expiry the chain may lag a transfer mined in time: 'unused' is believed only after a grace period", async () => {
    const { c, checker } = chain();
    c.down = false;
    c.used = false; // the RPC node hasn't seen the block yet
    const env = await createTestEnv({ SETTLEMENT_MODE: "sync", MAX_TIMEOUT_SECONDS: "60" }, { checker });
    env.facilitator.settleThrows = "timeout";
    expect((await buyer(env).fetch(URL_)).status).toBe(503);
    const validBefore = (await statusOf(env)).validBefore.getTime();
    const realNow = Date.now;
    try {
      Date.now = () => validBefore + 30_000; // 30 s past expiry
      await env.deps.settler.tick(new Date(validBefore + 30_000));
      expect((await statusOf(env)).status).toBe("verified");
      Date.now = () => validBefore + 121_000; // past the 2 min grace
      await env.deps.settler.tick(new Date(validBefore + 3_600_000));
      expect((await statusOf(env)).status).toBe("failed");
    } finally {
      Date.now = realNow;
    }
  });
});

