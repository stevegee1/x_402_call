import { GatewayAdminClient, publicClient, Reconciler } from "@mx/reconcile";
import type { Address } from "viem";

/**
 * The production reconciler, pointed at the local stack: no confirmations (anvil automines) and no
 * in-flight grace (callers wait for quiescence first), so any difference is a problem.
 */
export async function reconcileStack(o: { gatewayUrl: string; adminToken: string; rpcUrl: string; payTo: Address; fromBlock: bigint }) {
  const r = new Reconciler(publicClient(o.rpcUrl), new GatewayAdminClient(o.gatewayUrl, o.adminToken), {
    network: "eip155:84532",
    payTo: o.payTo,
    fromBlock: o.fromBlock,
    confirmations: 0n,
    pendingGraceMs: 0,
  });
  return r.run();
}

export const fetchPayments = (gatewayUrl: string, adminToken: string) => new GatewayAdminClient(gatewayUrl, adminToken).payments();
