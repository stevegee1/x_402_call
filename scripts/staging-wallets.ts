/**
 * Creates the staging (Base Sepolia) wallets that don't exist yet and stores their private keys in
 * the macOS Keychain. Prints only the new public addresses and the current block. Never overwrites
 * an existing key.
 *
 *   pnpm staging:wallets
 *
 * Keychain items (service names), readable with `security find-generic-password -s <name> -w`:
 *   x402-staging-pay-to        payee: receives staging payments (receive-only)
 *   x402-staging-facilitator   facilitator gas wallet: fund with Base Sepolia ETH; set in Railway
 *   x402-staging-gas-keeper    gas-keeper float: holds test USDC + a little ETH; tops up the facilitator
 */
import { execFileSync } from "node:child_process";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ITEMS = [
  ["x402-staging-pay-to", "PAY_TO"],
  ["x402-staging-facilitator", "FACILITATOR"],
  ["x402-staging-gas-keeper", "GAS_KEEPER"],
] as const;

const exists = (svc: string) => {
  try {
    execFileSync("security", ["find-generic-password", "-s", svc, "-a", "x402"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const missing = ITEMS.filter(([svc]) => !exists(svc));
if (!missing.length) throw new Error("every staging wallet already exists; delete a Keychain item deliberately to regenerate it");

const out: Record<string, string> = {};
for (const [svc, label] of missing) {
  const key = generatePrivateKey();
  // execFile (no shell): the key goes straight to `security`; it is never printed or written to disk.
  execFileSync("security", ["add-generic-password", "-s", svc, "-a", "x402", "-l", `x402 staging ${label} key (Base Sepolia)`, "-w", key]);
  out[label] = privateKeyToAccount(key).address;
}
const block = await createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") }).getBlockNumber();
console.log(JSON.stringify({ ...out, block: block.toString() }));
