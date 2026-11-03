/**
 * Creates the two staging (Base Sepolia) wallets and stores their private keys in the macOS
 * Keychain. Prints only the public addresses and the current block. Refuses to overwrite.
 *
 *   pnpm staging:wallets
 *
 * Keychain items (service names), readable with `security find-generic-password -s <name> -w`:
 *   x402-staging-pay-to        payee: receives staging payments (receive-only)
 *   x402-staging-facilitator   facilitator gas wallet: fund with Base Sepolia ETH; set in Railway
 */
import { execFileSync } from "node:child_process";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ITEMS = [
  ["x402-staging-pay-to", "PAY_TO"],
  ["x402-staging-facilitator", "FACILITATOR"],
] as const;

const exists = (svc: string) => {
  try {
    execFileSync("security", ["find-generic-password", "-s", svc, "-a", "x402"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
for (const [svc] of ITEMS) if (exists(svc)) throw new Error(`Keychain item ${svc} already exists; delete it deliberately before regenerating`);

const out: Record<string, string> = {};
for (const [svc, label] of ITEMS) {
  const key = generatePrivateKey();
  // execFile (no shell): the key goes straight to `security`; it is never printed or written to disk.
  execFileSync("security", ["add-generic-password", "-s", svc, "-a", "x402", "-l", `x402 staging ${label} key (Base Sepolia)`, "-w", key]);
  out[label] = privateKeyToAccount(key).address;
}
const block = await createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") }).getBlockNumber();
console.log(JSON.stringify({ ...out, block: block.toString() }));
