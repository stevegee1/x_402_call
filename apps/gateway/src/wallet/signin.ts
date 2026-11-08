import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createPublicClient, getAddress, http, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

/**
 * "Sign in with Ethereum" (EIP-4361) to view a wallet's own activity on /wallet. No state: the
 * challenge is bound to the address, our domain and a 5-minute window, and MACed with a server key,
 * so a proof is (message, MAC, signature) and nothing is stored. It moves no funds and approves
 * nothing; it only proves the visitor controls the address.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;

export type Verifier = (address: Address, message: string, signature: Hex) => Promise<boolean>;

/**
 * EOA signatures recover locally. With an RPC URL, smart-contract wallets (EIP-1271) and
 * not-yet-deployed ones (EIP-6492, e.g. Coinbase Smart Wallet) verify too.
 */
export function makeVerifier(network: string, rpcUrl?: string): Verifier {
  if (!rpcUrl) return async (address, message, signature) => verifyMessage({ address, message, signature }).catch(() => false);
  const client = createPublicClient({ chain: network === "eip155:8453" ? base : baseSepolia, transport: http(rpcUrl, { timeout: 5_000 }) });
  return async (address, message, signature) => client.verifyMessage({ address, message, signature }).catch(() => false);
}

export interface SignInOptions {
  /** Server secret the challenge MAC key is derived from. */
  secret: string;
  baseUrl: string;
  chainId: number;
  verify: Verifier;
  now?: () => number;
}

export type ProofError = "invalid_address" | "malformed" | "bad_mac" | "expired" | "wrong_domain" | "bad_signature";

export class WalletSignIn {
  private readonly key: Buffer;
  private readonly host: string;
  private readonly now: () => number;

  constructor(private readonly o: SignInOptions) {
    // A derived key: the session secret itself is never used for anything but its own purpose.
    this.key = createHmac("sha256", o.secret).update("wearebase/wallet-signin/v1").digest();
    this.host = new URL(o.baseUrl).host;
    this.now = o.now ?? Date.now;
  }

  private mac(message: string) {
    return createHmac("sha256", this.key).update(message).digest("base64url");
  }

  challenge(address: string): { message: string; mac: string } | { error: ProofError } {
    if (!isAddress(address, { strict: false })) return { error: "invalid_address" };
    const issued = new Date(this.now());
    const expires = new Date(issued.getTime() + CHALLENGE_TTL_MS);
    const message = [
      `${this.host} wants you to sign in with your Ethereum account:`,
      getAddress(address),
      "",
      "View your wearebase payments and sessions. This signature does not move funds or approve any spending.",
      "",
      `URI: ${this.o.baseUrl}/wallet`,
      "Version: 1",
      `Chain ID: ${this.o.chainId}`,
      `Nonce: ${randomBytes(12).toString("hex")}`,
      `Issued At: ${issued.toISOString()}`,
      `Expiration Time: ${expires.toISOString()}`,
    ].join("\n");
    return { message, mac: this.mac(message) };
  }

  /** The proven address (checksummed), or why the proof was refused. */
  async verify(message: unknown, mac: unknown, signature: unknown): Promise<{ address: Address } | { error: ProofError }> {
    if (typeof message !== "string" || typeof mac !== "string" || typeof signature !== "string" || message.length > 2_000 || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 20_000)
      return { error: "malformed" };
    const expected = Buffer.from(this.mac(message));
    const got = Buffer.from(mac);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { error: "bad_mac" };
    // The MAC proves we issued this exact text, so its fields can be trusted as written.
    const lines = message.split("\n");
    if (lines[0] !== `${this.host} wants you to sign in with your Ethereum account:`) return { error: "wrong_domain" };
    const address = lines[1] ?? "";
    const expiry = Date.parse(lines.find((l) => l.startsWith("Expiration Time: "))?.slice(17) ?? "");
    if (!isAddress(address) || !Number.isFinite(expiry)) return { error: "malformed" };
    if (this.now() > expiry) return { error: "expired" };
    if (!(await this.o.verify(address, message, signature as Hex))) return { error: "bad_signature" };
    return { address };
  }
}
