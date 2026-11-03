import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { scanTransfers, USDC } from "../src/chain";
import { reconcile, type LedgerPayment } from "../src/core";
import { Reconciler } from "../src/reconciler";
import { GatewayAdminClient, parseLedgerCsv } from "../src/sources";

const ASSET = USDC["eip155:84532"]!;
const PAY_TO = "0x00000000000000000000000000000000000000aa" as Address;
const A = "0x00000000000000000000000000000000000000A1" as Address;
const n = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`;
const tx = (i: number) => `0x${(1000 + i).toString(16).padStart(64, "0")}` as `0x${string}`;

/** Logs as viem returns them: one AuthorizationUsed right before its Transfer, per settlement block. */
function fakeChain(settlements: { block: bigint; i: number; value?: bigint; plain?: boolean }[], opts: { maxRange?: bigint; latest?: bigint } = {}) {
  const calls: [bigint, bigint][] = [];
  return {
    calls,
    getBlockNumber: vi.fn(async () => opts.latest ?? 1_000n),
    readContract: vi.fn(async () => settlements.reduce((s, x) => s + (x.value ?? 33_000n), 0n)),
    getContractEvents: vi.fn(async (q: { eventName: string; fromBlock: bigint; toBlock: bigint }) => {
      if (opts.maxRange && q.toBlock - q.fromBlock + 1n > opts.maxRange) throw new Error("block range too large");
      if (q.eventName === "Transfer") calls.push([q.fromBlock, q.toBlock]);
      return settlements
        .filter((s) => s.block >= q.fromBlock && s.block <= q.toBlock)
        .flatMap((s): unknown[] =>
          q.eventName === "Transfer"
            ? [{ transactionHash: tx(s.i), logIndex: 1, blockNumber: s.block, args: { from: A, to: PAY_TO, value: s.value ?? 33_000n } }]
            : s.plain
              ? []
              : [{ transactionHash: tx(s.i), logIndex: 0, blockNumber: s.block, args: { authorizer: A, nonce: n(s.i) } }],
        );
    }),
  };
}

describe("scanTransfers", () => {
  it("pairs each transfer with the nonce authorised in the same tx", async () => {
    const out = await scanTransfers(fakeChain([{ block: 5n, i: 1 }, { block: 7n, i: 2, plain: true }]) as never, ASSET, PAY_TO, 0n, 10n);
    expect(out).toEqual([
      { tx: tx(1), from: A.toLowerCase(), value: 33_000n, nonce: n(1), block: 5n },
      { tx: tx(2), from: A.toLowerCase(), value: 33_000n, nonce: null, block: 7n },
    ]);
  });

  it("chunks the range and halves a chunk the RPC rejects, without losing blocks", async () => {
    const chain = fakeChain([{ block: 0n, i: 1 }, { block: 999n, i: 2 }, { block: 2_500n, i: 3 }], { maxRange: 300n });
    const out = await scanTransfers(chain as never, ASSET, PAY_TO, 0n, 2_999n, 1_000n);
    expect(out.map((t) => t.block)).toEqual([0n, 999n, 2_500n]);
    // Contiguous, gap-free coverage of [0, 2999], every window within the RPC's limit.
    const sorted = [...chain.calls].sort((a, b) => Number(a[0] - b[0]));
    expect(sorted[0]![0]).toBe(0n);
    expect(sorted.at(-1)![1]).toBe(2_999n);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]![0]).toBe(sorted[i - 1]![1] + 1n);
    for (const [a, b] of sorted) expect(b - a + 1n).toBeLessThanOrEqual(300n);
  });

  it("gives up when even a single block fails", async () => {
    const chain = { getContractEvents: async () => Promise.reject(new Error("rpc down")) };
    await expect(scanTransfers(chain as never, ASSET, PAY_TO, 0n, 10n)).rejects.toThrow("rpc down");
  });
});

describe("in-flight grace", () => {
  const now = 1_800_000_000_000;
  const settled = (i: number): LedgerPayment => ({ id: `p${i}`, status: "settled", payer: A.toLowerCase(), nonce: n(i), amountAtomic: 33_000n, tx: tx(i), createdAt: now - 3_600_000 });
  const journal = (i: number) => ({ ref: `p${i}`, usdcAtomic: 33_000n, grossGbpMicros: 26_400, fx: 0.8, tx: tx(i) });

  it("a young verified payment already on chain is not a problem yet; an old one is", () => {
    const young: LedgerPayment = { ...settled(2), status: "verified", tx: null, createdAt: now - 60_000 };
    const input = {
      payments: [settled(1), young],
      transfers: [
        { tx: tx(1), from: A.toLowerCase(), value: 33_000n, nonce: n(1) },
        { tx: tx(2), from: A.toLowerCase(), value: 33_000n, nonce: n(2) },
      ],
      journal: [journal(1)],
      payToBalance: 66_000n,
      ledgerChainOk: true,
      now,
    };
    expect(reconcile({ ...input, pendingGraceMs: 15 * 60_000 }).problems).toEqual([]);
    const strict = reconcile({ ...input, pendingGraceMs: 0 }).problems.map((p) => p.code);
    expect(strict).toEqual(["pending_payments", "onchain_but_not_settled", "balance_mismatch"]);
    const old = reconcile({ ...input, payments: [settled(1), { ...young, createdAt: now - 16 * 60_000 }], pendingGraceMs: 15 * 60_000 });
    expect(old.problems.map((p) => p.code)).toContain("pending_payments");
  });
});

describe("Reconciler (live, incremental)", () => {
  const gateway = (payments: LedgerPayment[]) => ({
    payments: vi.fn(async () => payments),
    journal: vi.fn(async () => payments.filter((p) => p.status === "settled").map((p) => ({ ref: p.id, usdcAtomic: p.amountAtomic, grossGbpMicros: Math.round(Number(p.amountAtomic) * 0.8), fx: 0.8, tx: p.tx }))),
    ledgerChainOk: vi.fn(async () => true),
  });
  const pay = (i: number): LedgerPayment => ({ id: `p${i}`, status: "settled", payer: A.toLowerCase(), nonce: n(i), amountAtomic: 33_000n, tx: tx(i), createdAt: 0 });

  it("scans only new blocks each run, behind the confirmation depth, and reads the balance at that block", async () => {
    const chain = fakeChain([{ block: 100n, i: 1 }], { latest: 1_000n });
    const r = new Reconciler(chain as never, gateway([pay(1)]), { network: "eip155:84532", payTo: PAY_TO, fromBlock: 50n, confirmations: 5n });
    const first = await r.run();
    expect(first).toMatchObject({ ok: true, toBlock: 995n, persistent: [] });
    expect(chain.readContract).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 995n }));
    chain.getBlockNumber.mockResolvedValueOnce(1_100n);
    chain.calls.length = 0;
    await r.run();
    expect(chain.calls).toEqual([[996n, 1_095n]]);
  });

  it("a problem is persistent only when two consecutive runs both see it", async () => {
    const chain = fakeChain([{ block: 100n, i: 1 }, { block: 101n, i: 9 }]); // i=9: unrecorded
    const r = new Reconciler(chain as never, gateway([pay(1)]), { network: "eip155:84532", payTo: PAY_TO, fromBlock: 0n });
    const first = await r.run();
    expect(first.problems.map((p) => p.code)).toEqual(["unrecorded_onchain_transfer", "balance_mismatch"]);
    expect(first.persistent).toEqual([]);
    const second = await r.run();
    expect(second.persistent.map((p) => p.code)).toEqual(["unrecorded_onchain_transfer", "balance_mismatch"]);
  });

  it("a transient problem that clears is never persistent", async () => {
    const payments = [pay(1)];
    const gw = gateway(payments);
    const chain = fakeChain([{ block: 100n, i: 1 }]);
    gw.ledgerChainOk.mockResolvedValueOnce(false);
    const r = new Reconciler(chain as never, gw, { network: "eip155:84532", payTo: PAY_TO, fromBlock: 0n });
    expect((await r.run()).problems.map((p) => p.code)).toEqual(["ledger_chain_broken"]);
    expect(await r.run()).toMatchObject({ ok: true, persistent: [] });
  });

  it("refuses a network without a canonical USDC", () => {
    expect(() => new Reconciler(fakeChain([]) as never, gateway([]), { network: "eip155:1", payTo: PAY_TO, fromBlock: 0n })).toThrow(/no canonical USDC/);
  });
});

describe("gateway admin client", () => {
  it("follows next_cursor until the last page and sends the admin token", async () => {
    const pages: Record<string, unknown> = {
      "": { next_cursor: "11111111-1111-1111-1111-111111111111", data: [{ id: "a", status: "settled", payer: "0xa", nonce: "0x1", amount_atomic: "33000", tx: "0xt", created_at: "2026-11-03T12:00:00.000Z" }] },
      "11111111-1111-1111-1111-111111111111": { next_cursor: null, data: [{ id: "b", status: "verified", payer: "0xb", nonce: "0x2", amount_atomic: "66000", tx: null, created_at: "2026-11-03T11:00:00.000Z" }] },
    };
    const seen: { url: string; auth: string | null }[] = [];
    const client = new GatewayAdminClient("https://gw.test/", "t".repeat(32), (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      const cursor = new URL(url).searchParams.get("cursor") ?? "";
      return new Response(JSON.stringify(pages[cursor]));
    }) as typeof fetch);
    const out = await client.payments();
    expect(out.map((p) => [p.id, p.amountAtomic, p.createdAt])).toEqual([
      ["a", 33_000n, Date.parse("2026-11-03T12:00:00.000Z")],
      ["b", 66_000n, Date.parse("2026-11-03T11:00:00.000Z")],
    ]);
    expect(seen.map((s) => s.url)).toEqual(["https://gw.test/admin/payments?limit=500", "https://gw.test/admin/payments?limit=500&cursor=11111111-1111-1111-1111-111111111111"]);
    expect(seen.every((s) => s.auth === `Bearer ${"t".repeat(32)}`)).toBe(true);
  });

  it("surfaces HTTP errors", async () => {
    const client = new GatewayAdminClient("https://gw.test", "t".repeat(32), (async () => new Response("no", { status: 401 })) as typeof fetch);
    await expect(client.payments()).rejects.toThrow(/HTTP 401/);
  });

  it("parses the ledger export's settlement lines", () => {
    const csv = [
      "seq,occurred_at,kind,ref,account,debit_gbp,credit_gbp,vat_treatment,usdc_amount,fx_usdc_gbp,fx_source,tx_hash,hash",
      "1,2026-11-03T12:00:00.000Z,x402_settlement,p1,asset:usdc_wallet,0.026400,0.000000,uk_standard_inclusive,0.033,0.8,fixed,0xt,h1",
      "1,2026-11-03T12:00:00.000Z,x402_settlement,p1,revenue:grid,0.000000,0.022000,uk_standard_inclusive,0.033,0.8,fixed,0xt,h1",
      "2,2026-11-03T12:01:00.000Z,credits_usage,r2,liability:credits,0.025000,0.000000,,,,,,h2",
    ].join("\n");
    expect(parseLedgerCsv(csv)).toEqual([{ ref: "p1", usdcAtomic: 33_000n, grossGbpMicros: 26_400, fx: 0.8, tx: "0xt" }]);
    expect(() => parseLedgerCsv("seq,kind\n")).toThrow(/no ref column/);
  });
});
