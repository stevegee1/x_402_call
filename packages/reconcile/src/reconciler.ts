import type { Address, PublicClient } from "viem";
import { scanTransfers, USDC, USDC_ABI, type ScannedTransfer } from "./chain";
import { reconcile, type Problem, type ReconcileReport } from "./core";
import type { GatewayAdminClient } from "./sources";

export interface ReconcilerOptions {
  network: string;
  payTo: Address;
  /** First block to scan: the block where this payTo started receiving (staging: when it was created). */
  fromBlock: bigint;
  /** Only reconcile up to latest - confirmations, so a reorged block is never counted. */
  confirmations?: bigint;
  /** In-flight payments younger than this are not problems yet. */
  pendingGraceMs?: number;
  logChunk?: bigint;
}

export interface RunResult extends ReconcileReport {
  /** Problems also present in the previous run: what an operator should be paged for. */
  persistent: Problem[];
  toBlock: bigint;
  durationMs: number;
}

export const problemKey = (p: Problem) => JSON.stringify(p);

/**
 * Stateful ledger <-> chain reconciler for a live system. Each run scans only blocks not yet seen,
 * reads payTo's balance at the same block it scanned to (so the two views agree), and compares with
 * the gateway's ledger. Because settlement is eventually consistent, a problem is reported every
 * run but counts as `persistent` only when two consecutive runs both see it.
 */
export class Reconciler {
  private transfers: ScannedTransfer[] = [];
  private scannedTo: bigint;
  private previous = new Set<string>();
  readonly asset: Address;

  constructor(
    private readonly chain: Pick<PublicClient, "getContractEvents" | "getBlockNumber" | "readContract">,
    private readonly gateway: Pick<GatewayAdminClient, "payments" | "journal" | "ledgerChainOk">,
    private readonly o: ReconcilerOptions,
  ) {
    const asset = USDC[o.network];
    if (!asset) throw new Error(`no canonical USDC for ${o.network}`);
    this.asset = asset;
    this.scannedTo = o.fromBlock - 1n;
  }

  async run(now = Date.now()): Promise<RunResult> {
    const t0 = Date.now();
    const latest = await this.chain.getBlockNumber();
    const toBlock = latest - (this.o.confirmations ?? 5n);
    if (toBlock > this.scannedTo) {
      const fresh = await scanTransfers(this.chain, this.asset, this.o.payTo, this.scannedTo + 1n, toBlock, this.o.logChunk);
      this.transfers.push(...fresh);
      this.scannedTo = toBlock;
    }
    const [payments, journal, ledgerChainOk, payToBalance] = await Promise.all([
      this.gateway.payments(),
      this.gateway.journal(),
      this.gateway.ledgerChainOk(),
      this.chain.readContract({ address: this.asset, abi: USDC_ABI, functionName: "balanceOf", args: [this.o.payTo], blockNumber: this.scannedTo }) as Promise<bigint>,
    ]);
    const report = reconcile({ payments, transfers: this.transfers, journal, payToBalance, ledgerChainOk, pendingGraceMs: this.o.pendingGraceMs ?? 15 * 60_000, now });
    const keys = new Set(report.problems.map(problemKey));
    const persistent = report.problems.filter((p) => this.previous.has(problemKey(p)));
    this.previous = keys;
    return { ...report, persistent, toBlock: this.scannedTo, durationMs: Date.now() - t0 };
  }
}
