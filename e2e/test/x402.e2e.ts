/**
 * End to end, with nothing faked except the chain itself (a local anvil) and the token (MockUSDC at
 * the Base Sepolia USDC address): real gateway processes on real Postgres, the real self-hosted
 * facilitator, real EIP-3009 signatures and on-chain settlement. Scenarios run in order and the last
 * one reconciles every payment they made against the chain.
 */
import { decodePaymentResponseHeader } from "@x402/core/http";
import { decodeEventLog, parseSignature, type Address, type Hex } from "viem";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { pay, sendSigned, sign, newBuyer, encode, type Buyer } from "../src/buyer";
import { ANVIL_KEYS, BASE_SEPOLIA_USDC, clients, ERC8004_IDENTITY, giveFeedback, registerAgent, transferAgent, USDC_ABI, usdcBalance } from "../src/chain";
import { fetchPayments, reconcileStack } from "../src/reconcile";

const stack = inject("stack");
const chain = clients(stack.rpcUrl);
const gw = stack.gateways;
const VESSELS = "/v1/maritime/dover/vessels";
const PRICE = 33_000n; // maritime.vessels: $0.033

/** Payments each scenario expects to end up settled; the final reconciliation checks the total. */
let expectedSettled = 0;

const isUsed = (payer: Address, nonce: string) =>
  chain.public.readContract({ address: BASE_SEPOLIA_USDC, abi: USDC_ABI, functionName: "authorizationState", args: [payer, nonce as Hex] });

async function waitPayment(gatewayUrl: string, id: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await (await fetch(`${gatewayUrl}/v1/payments/${id}`)).json();
    if (p.status !== "verified") return p as { status: string; transaction: string | null; amount_usdc: number; resource: string };
    if (Date.now() > deadline) throw new Error(`payment ${id} still verified after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The receipt succeeded and moved exactly `value` from the buyer to payTo, consuming `nonce`. */
async function expectOnChainSettlement(txHash: string, buyer: Address, nonce: string, value = PRICE) {
  const receipt = await chain.public.getTransactionReceipt({ hash: txHash as Hex });
  expect(receipt.status).toBe("success");
  expect(receipt.from.toLowerCase()).toBe(stack.facilitator.signer.toLowerCase()); // the facilitator paid the gas
  const events = receipt.logs
    .filter((l) => l.address.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase())
    .map((l) => decodeEventLog({ abi: USDC_ABI, data: l.data, topics: l.topics }));
  expect(events).toEqual([
    { eventName: "AuthorizationUsed", args: { authorizer: buyer, nonce } },
    { eventName: "Transfer", args: { from: buyer, to: stack.payTo, value } },
  ]);
  expect(await isUsed(buyer, nonce)).toBe(true);
}

async function adminPayments() {
  return fetchPayments(gw.async, stack.adminToken);
}

describe("stack", () => {
  it("every gateway replica is ready and serving maritime", async () => {
    for (const url of Object.values(gw)) {
      const r = await (await fetch(`${url}/readyz`)).json();
      expect(r).toEqual({ ok: true, db: true, products: { maritime: true }, facilitator_breaker: "closed" });
    }
  });

  it("the facilitator advertises exact/eip155:84532 and requires its token", async () => {
    const unauth = await fetch(`${stack.facilitator.url}/supported`);
    expect(unauth.status).toBe(401);
    const settle = await fetch(`${stack.facilitator.url}/settle`, { method: "POST", body: "{}" });
    expect(settle.status).toBe(401);
    const s = await (await fetch(`${stack.facilitator.url}/supported`, { headers: { authorization: `Bearer ${stack.facilitator.token}` } })).json();
    expect(s.kinds).toContainEqual(expect.objectContaining({ x402Version: 2, scheme: "exact", network: "eip155:84532" }));
    expect(Object.values(s.signers).flat()).toContain(stack.facilitator.signer);
  });

  it("the challenge offers USDC at the canonical Base Sepolia address, to our payTo", async () => {
    const res = await fetch(`${gw.async}${VESSELS}`);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", asset: BASE_SEPOLIA_USDC, amount: "33000", payTo: stack.payTo });
  });
});

describe("x402: async settlement", () => {
  let buyer: Buyer;
  beforeAll(async () => {
    buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
  });

  it("serves immediately, settles on chain shortly after, and the buyer never needs gas", async () => {
    const facGasBefore = await chain.public.getBalance({ address: stack.facilitator.signer });
    const { res, nonce } = await pay(buyer, `${gw.async}${VESSELS}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Settlement")).toBe("pending");
    const body = await res.json();
    expect(body).toMatchObject({ region: "dover", mode: "simulated" });

    const id = res.headers.get("X-Payment-Id")!;
    const p = await waitPayment(gw.async, id);
    expect(p).toMatchObject({ status: "settled", amount_usdc: 0.033, resource: "maritime.vessels" });
    await expectOnChainSettlement(p.transaction!, buyer.address, nonce);
    expectedSettled++;

    expect(await usdcBalance(stack.rpcUrl, buyer.address)).toBe(1_000_000n - PRICE);
    expect(await chain.public.getBalance({ address: buyer.address })).toBe(0n);
    expect(await chain.public.getBalance({ address: stack.facilitator.signer })).toBeLessThan(facGasBefore);
  });

  it("a replay before settlement is caught by the shared payments table, on any replica (I3)", async () => {
    const { res, header, nonce } = await pay(buyer, `${gw.async}${VESSELS}`);
    expect(res.status).toBe(200);
    // Inside the async settle delay the nonce is still unused on chain, so only Postgres can stop this.
    for (const url of [gw.sync, gw.async]) {
      const replay = await sendSigned(`${url}${VESSELS}`, header);
      expect(replay.status).toBe(402);
      expect((await replay.json()).error).toBe("payment_already_used");
    }
    const p = await waitPayment(gw.async, res.headers.get("X-Payment-Id")!);
    await expectOnChainSettlement(p.transaction!, buyer.address, nonce);
    expectedSettled++;
  });

  it("a replay after settlement is refused at verify (nonce used on chain), and nothing moves", async () => {
    const { res, header } = await pay(buyer, `${gw.async}${VESSELS}`);
    expect(res.status).toBe(200);
    await waitPayment(gw.async, res.headers.get("X-Payment-Id")!);
    expectedSettled++;
    const balance = await usdcBalance(stack.rpcUrl, buyer.address);

    for (const url of [gw.async, gw.sync, gw.failover]) {
      const replay = await sendSigned(`${url}${VESSELS}`, header);
      expect(replay.status).toBe(402);
      expect((await replay.json()).error).toBe("invalid_exact_evm_nonce_already_used");
    }
    expect(await usdcBalance(stack.rpcUrl, buyer.address)).toBe(balance);
  });
});

describe("x402: sync settlement", () => {
  it("settles before serving and returns the on-chain transaction in PAYMENT-RESPONSE", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const { res, nonce } = await pay(buyer, `${gw.sync}${VESSELS}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Settlement")).toBe("settled");
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settle).toMatchObject({ success: true, network: "eip155:84532" });
    await expectOnChainSettlement(settle.transaction, buyer.address, nonce);
    expectedSettled++;

    const p = await waitPayment(gw.sync, res.headers.get("X-Payment-Id")!);
    expect(p.transaction).toBe(settle.transaction);
  });
});

describe("x402: replicas share one settlement queue (I7)", () => {
  it("concurrent async payments each settle exactly once, whichever replica claims them", async () => {
    const buyers = await Promise.all(Array.from({ length: 10 }, () => newBuyer(stack.rpcUrl, 100_000n)));
    // Spread purchases across both direct-facilitator async/sync replicas; all four settlement loops compete.
    const paid = await Promise.all(buyers.map((b, i) => pay(b, `${i % 2 ? gw.async : gw.sync}${VESSELS}`)));
    for (const p of paid) expect(p.res.status).toBe(200);

    const settled = await Promise.all(paid.map((p, i) => waitPayment(i % 2 ? gw.async : gw.sync, p.res.headers.get("X-Payment-Id")!)));
    expect(settled.every((s) => s.status === "settled")).toBe(true);
    expect(new Set(settled.map((s) => s.transaction)).size).toBe(10);
    await Promise.all(settled.map((s, i) => expectOnChainSettlement(s.transaction!, buyers[i]!.address, paid[i]!.nonce)));
    for (const b of buyers) expect(await usdcBalance(stack.rpcUrl, b.address)).toBe(100_000n - PRICE);
    expectedSettled += 10;
  });
});

describe("x402: exposure caps are global across replicas (R4)", () => {
  it("one payer's concurrent payments on two replicas: only what fits the per-payer cap is served before settlement", async () => {
    expect(stack.perPayerCapUsd).toBe(0.1); // three $0.033 payments fit; a fourth would not
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const paid = await Promise.all(Array.from({ length: 6 }, (_, i) => pay(buyer, `${i % 2 ? gw.async : gw.flaky}${VESSELS}`)));
    for (const p of paid) expect(p.res.status).toBe(200);
    const modes = paid.map((p) => p.res.headers.get("X-Settlement"));
    // Per-replica counters would admit three on each replica: six served unsettled, double the cap.
    expect(modes.filter((m) => m === "pending")).toHaveLength(3);
    expect(modes.filter((m) => m === "settled")).toHaveLength(3);

    for (const [i, p] of paid.entries()) {
      const s = await waitPayment(i % 2 ? gw.async : gw.flaky, p.res.headers.get("X-Payment-Id")!);
      expect(s.status).toBe("settled");
      await expectOnChainSettlement(s.transaction!, buyer.address, p.nonce);
    }
    expectedSettled += 6;
    expect(await usdcBalance(stack.rpcUrl, buyer.address)).toBe(1_000_000n - 6n * PRICE);
  });
});

describe("ERC-8004 buyer tiers (loosen-only)", () => {
  /** n concurrent payments from one buyer across two async replicas; returns each X-Settlement / X-Agent-Tier. */
  async function burst(buyer: Buyer, n: number, agentId?: string) {
    const headers: Record<string, string> = agentId ? { "X-Agent-Id": agentId } : {};
    const paid = await Promise.all(Array.from({ length: n }, (_, i) => pay(buyer, `${i % 2 ? gw.async : gw.flaky}${VESSELS}`, headers)));
    for (const p of paid) expect(p.res.status).toBe(200);
    for (const [i, p] of paid.entries()) {
      const s = await waitPayment(i % 2 ? gw.async : gw.flaky, p.res.headers.get("X-Payment-Id")!);
      expect(s.status).toBe("settled");
      await expectOnChainSettlement(s.transaction!, buyer.address, p.nonce);
    }
    expectedSettled += n;
    return {
      pending: paid.filter((p) => p.res.headers.get("X-Settlement") === "pending").length,
      tiers: new Set(paid.map((p) => p.res.headers.get("X-Agent-Tier"))),
    };
  }

  it("a registered agent paying from its verified wallet gets the identified cap (6 in flight, not 3)", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const agentId = await registerAgent(stack.rpcUrl, buyer.key);
    const r = await burst(buyer, 8, agentId.toString());
    expect(r.pending).toBe(6);
    expect(r.tiers).toEqual(new Set(["identified"]));
  });

  it("three good reviews from our trusted reviewer lift it to trusted (9 in flight), via the global id form", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const agentId = await registerAgent(stack.rpcUrl, buyer.key);
    for (const v of [90, 85, 95]) await giveFeedback(stack.rpcUrl, ANVIL_KEYS.reviewer, agentId, v);
    const r = await burst(buyer, 10, `eip155:84532:${ERC8004_IDENTITY}:${agentId}`);
    expect(r.pending).toBe(9);
    expect(r.tiers).toEqual(new Set(["trusted"]));
  });

  it("reviews from anyone else don't count", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const agentId = await registerAgent(stack.rpcUrl, buyer.key);
    const stranger = (await newBuyer(stack.rpcUrl, 0n)).key;
    for (let i = 0; i < 5; i++) await giveFeedback(stack.rpcUrl, stranger, agentId, 100);
    const r = await burst(buyer, 7, agentId.toString());
    expect(r.pending).toBe(6);
    expect(r.tiers).toEqual(new Set(["identified"]));
  });

  it("claiming someone else's agent, or one whose NFT has been transferred, gets the default cap", async () => {
    const owner = await newBuyer(stack.rpcUrl, 0n);
    const famous = await registerAgent(stack.rpcUrl, owner.key);
    for (const v of [99, 99, 99]) await giveFeedback(stack.rpcUrl, ANVIL_KEYS.reviewer, famous, v);
    const impostor = await newBuyer(stack.rpcUrl, 1_000_000n);
    const spoof = await burst(impostor, 4, famous.toString());
    expect(spoof).toEqual({ pending: 3, tiers: new Set(["unknown"]) });

    // A transfer clears the verified wallet: the old owner can no longer claim the agent.
    const seller = await newBuyer(stack.rpcUrl, 1_000_000n);
    const sold = await registerAgent(stack.rpcUrl, seller.key);
    await transferAgent(stack.rpcUrl, seller.key, sold, impostor.address);
    const after = await burst(seller, 4, sold.toString());
    expect(after).toEqual({ pending: 3, tiers: new Set(["unknown"]) });
  });

  it("the gateway advertises the buyer header and registry", async () => {
    const root = await (await fetch(`${gw.async}/`)).json();
    expect(root.identity.buyer).toEqual({ header: "X-Agent-Id", agent_registry: `eip155:84532:${ERC8004_IDENTITY}` });
  });
});

describe("x402: nothing is charged when the payment is bad or the request is refused", () => {
  it("a buyer without funds is refused at verify; no payment row, nothing on chain", async () => {
    const broke = await newBuyer(stack.rpcUrl, 0n);
    const { res, nonce } = await pay(broke, `${gw.async}${VESSELS}`);
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("invalid_exact_evm_insufficient_balance");
    expect(await isUsed(broke.address, nonce)).toBe(false);
    expect((await adminPayments()).some((p) => p.payer === broke.address.toLowerCase())).toBe(false);
  });

  it("a tampered amount fails signature verification", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const { payload } = await sign(buyer, `${gw.async}${VESSELS}`);
    const auth = (payload.payload as { authorization: { value: string; nonce: string } }).authorization;
    auth.value = "1";
    payload.accepted = { ...payload.accepted, amount: "1" };
    const res = await sendSigned(`${gw.async}${VESSELS}`, encode(buyer, payload));
    expect(res.status).toBe(402);
    expect(await isUsed(buyer.address, auth.nonce)).toBe(false);
    expect(await usdcBalance(stack.rpcUrl, buyer.address)).toBe(1_000_000n);
  });

  it("a signature over the wrong domain (another chain id) is refused", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const { payload } = await sign(buyer, `${gw.async}${VESSELS}`);
    const p = payload.payload as { authorization: Record<string, string>; signature: Hex };
    const a = p.authorization;
    // Re-sign the same authorisation for Base mainnet: valid there, never here.
    p.signature = await buyer.account.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 8453, verifyingContract: BASE_SEPOLIA_USDC },
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
      message: { from: a.from as Address, to: a.to as Address, value: BigInt(a.value!), validAfter: BigInt(a.validAfter!), validBefore: BigInt(a.validBefore!), nonce: a.nonce as Hex },
    });
    expect(parseSignature(p.signature).r).toBeDefined();
    const res = await sendSigned(`${gw.async}${VESSELS}`, encode(buyer, payload));
    expect(res.status).toBe(402);
    expect(await isUsed(buyer.address, a.nonce!)).toBe(false);
  });

  it("a request refused before charging (unknown vessel, unknown region) never touches the authorisation", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    const { header, payload } = await sign(buyer, `${gw.sync}${VESSELS}`);
    const nonce = (payload.payload as { authorization: { nonce: string } }).authorization.nonce;
    const vessel = await sendSigned(`${gw.sync}${VESSELS}/999999999`, header);
    expect(vessel.status).toBe(404);
    expect((await vessel.json()).detail).toMatch(/not been charged/);
    const region = await sendSigned(`${gw.sync}/v1/maritime/atlantis/vessels`, header);
    expect(region.status).toBe(404);
    expect(await isUsed(buyer.address, nonce)).toBe(false);
    expect((await adminPayments()).some((p) => p.payer === buyer.address.toLowerCase())).toBe(false);

    // The untouched authorisation is still good for what it was signed for.
    const ok = await sendSigned(`${gw.sync}${VESSELS}`, header);
    expect(ok.status).toBe(200);
    expectedSettled++;
  });
});

describe("x402: facilitator outage", () => {
  const proxy = (state: "up" | "down") => fetch(`${stack.faultProxyControlUrl}/${state}`, { method: "POST" });

  it("without a fallback: 503, Retry-After, not charged. With a fallback: served and settled. Then recovery.", async () => {
    const buyer = await newBuyer(stack.rpcUrl, 1_000_000n);
    await proxy("down");
    try {
      const { res, nonce } = await pay(buyer, `${gw.flaky}${VESSELS}`);
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(await res.json()).toMatchObject({ error: "payments_unavailable" });
      expect(await isUsed(buyer.address, nonce)).toBe(false);

      // Primary down, fallback up: the failover replica verifies and settles through the fallback.
      const fo = await pay(buyer, `${gw.failover}${VESSELS}`);
      expect(fo.res.status).toBe(200);
      expect(fo.res.headers.get("X-Settlement")).toBe("settled");
      await expectOnChainSettlement(decodePaymentResponseHeader(fo.res.headers.get("PAYMENT-RESPONSE")!).transaction, buyer.address, fo.nonce);
      expectedSettled++;
    } finally {
      await proxy("up");
    }

    const again = await pay(buyer, `${gw.flaky}${VESSELS}`);
    expect(again.res.status).toBe(200);
    const p = await waitPayment(gw.flaky, again.res.headers.get("X-Payment-Id")!);
    expect(p.status).toBe("settled");
    await expectOnChainSettlement(p.transaction!, buyer.address, again.nonce);
    expectedSettled++;
  });
});

describe("credits rail", () => {
  it("a GBP-prepaid account pays per call with an API key; nothing touches the chain", async () => {
    const payToBefore = await usdcBalance(stack.rpcUrl, stack.payTo);
    const signup = await fetch(`${gw.async}/v1/credits/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: "E2E Shipping Ltd", email: "ops@e2e.test", country: "GB" }),
    });
    expect(signup.status).toBe(201);
    const { account_id, api_key } = await signup.json();

    const poor = await fetch(`${gw.async}${VESSELS}`, { headers: { authorization: `Bearer ${api_key}` } });
    expect(poor.status).toBe(402);
    expect((await poor.json()).error).toBe("insufficient_credits");

    const topup = await fetch(`${gw.async}/admin/credits/${account_id}/topup`, {
      method: "POST",
      headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ net_gbp: 1, reference: "e2e-bank-transfer-1" }),
    });
    expect(await topup.json()).toEqual({ result: "applied" });

    // Spend on a different replica than the one that sold the credits: the balance lives in Postgres.
    const res = await fetch(`${gw.sync}${VESSELS}`, { headers: { authorization: `Bearer ${api_key}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Credits-Charged-Gbp-Micros")).toBe("25000");
    expect(res.headers.get("X-Credits-Balance-Gbp-Micros")).toBe("975000");
    expect(await usdcBalance(stack.rpcUrl, stack.payTo)).toBe(payToBefore);
  });
});

describe("reconciliation", () => {
  async function quiescent() {
    const deadline = Date.now() + 60_000;
    while ((await adminPayments()).some((p) => p.status === "verified")) {
      if (Date.now() > deadline) throw new Error("payments still pending settlement after 60s");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const run = () => reconcileStack({ gatewayUrl: gw.sync, adminToken: stack.adminToken, rpcUrl: stack.rpcUrl, payTo: stack.payTo, fromBlock: BigInt(stack.startBlock) });

  it("ledger and chain agree exactly, in both directions", async () => {
    await quiescent();
    const report = await run();
    expect(report.problems).toEqual([]);
    expect(report.totals.settledCount).toBe(expectedSettled);
    expect(report.totals.payToBalance).toBe(PRICE * BigInt(expectedSettled));
  });

  it("every successful facilitator settle is exactly one settled payment (no double settlement)", async () => {
    const metrics = await (await fetch(`${stack.facilitator.url}/metrics`)).text();
    const success = Number(/facilitator_settle_total\{result="success"\} (\d+)/.exec(metrics)?.[1] ?? 0);
    expect(success).toBe(expectedSettled);
  });

  it("detects money that reached payTo outside the gateway", async () => {
    // A buyer's authorisation submitted straight to the token, bypassing the gateway and its ledger.
    const rogue = await newBuyer(stack.rpcUrl, 1_000_000n);
    const { payload } = await sign(rogue, `${gw.async}${VESSELS}`);
    const p = payload.payload as { authorization: Record<string, string>; signature: Hex };
    const a = p.authorization;
    const hash = await chain.deployer.writeContract({
      address: BASE_SEPOLIA_USDC,
      abi: USDC_ABI,
      functionName: "transferWithAuthorization",
      args: [a.from as Address, a.to as Address, BigInt(a.value!), BigInt(a.validAfter!), BigInt(a.validBefore!), a.nonce as Hex, p.signature],
    });
    expect((await chain.public.waitForTransactionReceipt({ hash })).status).toBe("success");

    const report = await run();
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { code: "unrecorded_onchain_transfer", tx: hash, from: rogue.address.toLowerCase(), value: "33000", nonce: a.nonce },
      { code: "balance_mismatch", balance: String(PRICE * BigInt(expectedSettled + 1)), transfers: String(PRICE * BigInt(expectedSettled + 1)), settled: String(PRICE * BigInt(expectedSettled)) },
    ]);
  });
});
