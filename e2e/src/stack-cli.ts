/**
 * Runs the e2e stack interactively: local chain, facilitator and gateway replicas, with a funded
 * demo wallet. Ctrl-C tears everything down.
 *
 *   TEST_PG_URL=postgres://user@host:port/postgres pnpm e2e:stack   # or with Docker: pnpm e2e:stack
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mintUsdc } from "./chain";
import { LOG_DIR } from "./proc";
import { reconcileStack } from "./reconcile";
import { startStack } from "./stack";

const { info, stop } = await startStack();
const key = generatePrivateKey();
const wallet = privateKeyToAccount(key).address;
await mintUsdc(info.rpcUrl, wallet, 10_000_000n); // 10 USDC

console.log(`
x402 stack is up (local chain ${info.rpcUrl}, chain id 84532)

  gateways     async ${info.gateways.async}   sync ${info.gateways.sync}
               flaky ${info.gateways.flaky}   failover ${info.gateways.failover}
  facilitator  ${info.facilitator.url}  (signer ${info.facilitator.signer})
  fault proxy  curl -XPOST ${info.faultProxyControlUrl}/down   (and /up)
  payTo        ${info.payTo}
  admin token  ${info.adminToken}
  logs         ${LOG_DIR}

Demo wallet ${wallet} holds 10 USDC and no ETH. Pay through the policy SDK:

  GATEWAY_URL=${info.gateways.async} WALLET_PRIVATE_KEY=${key} pnpm demo:agent

Ctrl-C reconciles the ledger against the chain, then stops everything.
`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    const r = await reconcileStack({ gatewayUrl: info.gateways.sync, adminToken: info.adminToken, rpcUrl: info.rpcUrl, payTo: info.payTo, fromBlock: BigInt(info.startBlock) });
    console.log(r.ok ? `reconciled: ${r.totals.settledCount} settlements, ${r.totals.payToBalance} atomic USDC` : `RECONCILIATION PROBLEMS:\n${JSON.stringify(r.problems, null, 2)}`);
  } catch (e) {
    console.error("reconciliation failed:", (e as Error).message);
  }
  await stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
