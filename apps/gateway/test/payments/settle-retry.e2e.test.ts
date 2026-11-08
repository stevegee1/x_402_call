import { createPolicyClient, DEFAULT_BREAKERS, type Policy } from "@mx/policy-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { isFinalReason } from "../../src/payments/settlement";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";

const policy = (): Policy => ({
  agentId: "test-agent",
  maxPricePerRequestUsd: 0.1,
  dailyBudgetUsd: 5,
  dailyBudgetGbp: 5,
  allowedNetworks: ["eip155:84532"],
  allowedOrigins: [BASE_URL],
  breakers: DEFAULT_BREAKERS,
});
const buyer = (env: TestEnv) => createPolicyClient({ policy: policy(), signer: privateKeyToAccount(generatePrivateKey()), fetch: env.fetch });
const TX_FAILED = "invalid_exact_evm_transaction_failed";

describe("settlement failure classification", () => {
  it("retries what was a bad moment, never what was a bad payment", () => {
    // Every x402 EVM code starts with "invalid_"; that prefix alone must not make a failure final.
    for (const r of [TX_FAILED, "invalid_exact_evm_transaction_simulation_failed", "settlement_pending", "unknown", "facilitator internal error", "503 Service Unavailable"]) expect(isFinalReason(r), r).toBe(false);
    for (const r of ["invalid_exact_evm_insufficient_balance", "invalid_exact_evm_signature", "invalid_exact_evm_payload_authorization_valid_before", "invalid_exact_evm_recipient_mismatch", "invalid_exact_evm_authorization_value", "insufficient_funds", "invalid_exact_evm_eip3009_not_supported"]) expect(isFinalReason(r), r).toBe(true);
  });
});

describe("sync settlement against a flaky facilitator", () => {
  it("retries a transient failure in place and serves the data", async () => {
    const env = await createTestEnv({ SETTLEMENT_MODE: "sync" });
    env.facilitator.flaky = { times: 2, reason: TX_FAILED };
    const res = await buyer(env).fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Settlement")).toBe("settled");
    expect(env.facilitator.settleCalls).toBe(3);
    expect(env.facilitator.settled).toHaveLength(1);
    expect(env.deps.metrics.render()).toMatch(/x402_settle_inline_retries_total\{reason="invalid_exact_evm_transaction_failed"\} 2/);
  });

  it("when it keeps failing: says not charged, and the payment can never be settled later", async () => {
    const env = await createTestEnv({ SETTLEMENT_MODE: "sync" });
    env.facilitator.flaky = { times: 10, reason: TX_FAILED };
    const res = await buyer(env).fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.status).toBe(402);
    expect(decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!).error).toBe(`settlement_failed: ${TX_FAILED}`);
    expect(env.facilitator.settleCalls).toBe(3); // one try plus two inline retries, then stop

    // The facilitator recovers. The worker must not pick the payment up and charge for data never served.
    env.facilitator.flaky = undefined;
    await env.deps.settler.tick(new Date(Date.now() + 10 * 60_000));
    expect(env.facilitator.settled).toHaveLength(0);
    const rows = await env.store.listPayments({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
  });

  it("doesn't retry a bad payment", async () => {
    const env = await createTestEnv({ SETTLEMENT_MODE: "sync" });
    env.facilitator.settleFails = "invalid_exact_evm_insufficient_balance";
    expect((await buyer(env).fetch(`${BASE_URL}/v1/maritime/dover/vessels`)).status).toBe(402);
    expect(env.facilitator.settleCalls).toBe(1);
  });
});

describe("async settlement against a flaky facilitator", () => {
  it("a served-early payment that hits a transient failure is retried by the worker, not written off", async () => {
    const env = await createTestEnv();
    const res = await buyer(env).fetch(`${BASE_URL}/v1/maritime/dover/vessels`);
    expect(res.headers.get("X-Settlement")).toBe("pending");
    const id = res.headers.get("X-Payment-Id")!;

    env.facilitator.flaky = { times: 1, reason: TX_FAILED };
    await env.deps.settler.tick(new Date(Date.now() + 10_000));
    expect((await env.store.getPayment(id))?.status).not.toBe("failed"); // was "failed" before the fix

    await env.deps.settler.tick(new Date(Date.now() + 120_000)); // after the backoff
    expect((await env.store.getPayment(id))?.status).toBe("settled");
    expect(env.facilitator.settled).toHaveLength(1);
  });
});
