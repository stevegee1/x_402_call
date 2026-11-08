import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { WALLET_CSP } from "../../src/routes/wallet";
import { WalletSignIn } from "../../src/wallet/signin";
import { WALLET_CORE_JS, WALLET_UI_JS } from "../../src/wallet/wallet-script";
import { BASE_URL, createTestEnv, type TestEnv } from "../helpers";

const NETWORK = "eip155:84532";
const BROWSER = "text/html,application/xhtml+xml,*/*;q=0.8";

type Core = {
  buySession(p: unknown, f: typeof fetch, o: Record<string, unknown>): Promise<Record<string, string>>;
  activity(p: unknown, f: typeof fetch, o: Record<string, unknown>): Promise<{ address: string; payments: Record<string, string>[]; sessions: Record<string, string>[] }>;
};

/** The page's real core script, run in a sandbox with only what a browser gives it. */
const loadCore = (): Core => runInNewContext(`${WALLET_CORE_JS};core`, { crypto: globalThis.crypto, TextEncoder, btoa, BigInt, JSON, Error, Promise, Number, String, Math, Date, Uint8Array });

/**
 * A browser wallet stand-in: EIP-1193 requests answered the way MetaMask answers them (decimal
 * strings in typed data, lowercase addresses), signed by a real key.
 */
function wallet(account: PrivateKeyAccount, opts: { chainId?: string; usdcAtomic?: bigint; reject?: string; locked?: boolean; staleOnce?: boolean; unlockAs?: PrivateKeyAccount } = {}) {
  const calls: string[] = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push(method);
      if (opts.reject === method) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      // A locked wallet (or one whose site access was removed) lists no accounts and refuses to sign.
      if ((method === "personal_sign" || method === "eth_signTypedData_v4") && (opts.locked || opts.staleOnce)) {
        opts.staleOnce = false;
        throw Object.assign(new Error("The requested account and/or method has not been authorized by the user."), { code: 4100 });
      }
      switch (method) {
        case "eth_accounts":
          return opts.locked ? [] : [account.address.toLowerCase()];
        case "eth_requestAccounts": // the unlock / connect prompt
          opts.locked = false;
          return [(opts.unlockAs ?? account).address.toLowerCase()];
        case "eth_chainId":
          return opts.chainId ?? "0x14a34";
        case "wallet_switchEthereumChain":
          opts.chainId = (params![0] as { chainId: string }).chainId;
          return null;
        case "eth_call":
          return `0x${(opts.usdcAtomic ?? 10_000_000n).toString(16).padStart(64, "0")}`;
        case "eth_signTypedData_v4": {
          const [from, json] = params as [string, string];
          expect(from.toLowerCase()).toBe(account.address.toLowerCase());
          const t = JSON.parse(json);
          const { EIP712Domain: _, ...types } = t.types;
          const m = t.message;
          return account.signTypedData({
            domain: t.domain,
            types,
            primaryType: t.primaryType,
            message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) },
          });
        }
        case "personal_sign": {
          const [hex] = params as [`0x${string}`];
          return account.signMessage({ message: { raw: hex } });
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { provider, calls };
}

const fetchVia = (env: TestEnv): typeof fetch => (input, init) => env.fetch(String(input), init);

describe("pay from a browser wallet (/wallet)", () => {
  it("buys a session with the page's own code, and the session works", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const w = wallet(account);
    const s = await loadCore().buySession(w.provider, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: account.address.toLowerCase() });
    expect(s.session_token).toMatch(/^ses_/);
    expect(s.amount_usdc).toBe("1");
    expect(w.calls).toEqual(["eth_chainId", "eth_call", "eth_accounts", "eth_signTypedData_v4"]); // no transaction, no gas
    expect(env.facilitator.settled).toHaveLength(1);

    const read = await env.fetch(`${BASE_URL}/v1/maritime/dover/vessels`, { headers: { authorization: `Session ${s.session_token}` } });
    expect(read.status).toBe(200);
  });

  it("switches the wallet to the right network first", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const w = wallet(account, { chainId: "0x1" });
    await loadCore().buySession(w.provider, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: account.address });
    expect(w.calls).toContain("wallet_switchEthereumChain");
  });

  it("stops before signing when the wallet can't afford it, and when the user declines", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const poor = wallet(account, { usdcAtomic: 500_000n });
    await expect(loadCore().buySession(poor.provider, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: account.address })).rejects.toThrow("insufficient_usdc");
    expect(poor.calls).not.toContain("eth_signTypedData_v4");

    const declines = wallet(account, { reject: "eth_signTypedData_v4" });
    await expect(loadCore().buySession(declines.provider, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: account.address })).rejects.toMatchObject({ code: 4001 });
    expect(env.facilitator.settled).toHaveLength(0);
  });

  it("a signature for one wallet can't pay from another", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const signer = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    // The page claims to be `other`, but the wallet signs with `signer`.
    const w = wallet(signer);
    // A lying wallet: claims `other` (so the page's own check passes) but signs with `signer`. The
    // server must still refuse it.
    const p = {
      request: async (a: { method: string; params?: unknown[] }) =>
        a.method === "eth_accounts" ? [other.address] : a.method === "eth_signTypedData_v4" ? w.provider.request({ ...a, params: [signer.address, a.params![1]] }) : w.provider.request(a),
    };
    await expect(loadCore().buySession(p, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: other.address })).rejects.toMatchObject({ status: 402 });
    expect(env.facilitator.settled).toHaveLength(0);
  });

  it("shows a wallet its own payments and sessions after it signs in", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const w = wallet(account);
    const core = loadCore();
    const s = await core.buySession(w.provider, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: account.address });
    const a = await core.activity(w.provider, fetchVia(env), { base: BASE_URL, from: account.address.toLowerCase() });
    expect(a.address).toBe(account.address);
    expect(a.sessions).toHaveLength(1);
    expect(a.sessions[0]).toMatchObject({ session_id: s.session_id, amount_atomic: "1000000", state: "active" });
    expect(a.payments[0]).toMatchObject({ endpoint: "sessions.usd1", amount_atomic: "1000000", status: "settled" });

    // Someone else's wallet sees nothing of it.
    const stranger = privateKeyToAccount(generatePrivateKey());
    const b = await core.activity(wallet(stranger).provider, fetchVia(env), { base: BASE_URL, from: stranger.address });
    expect(b.payments).toHaveLength(0);
    expect(b.sessions).toHaveLength(0);
  });
});

describe("a wallet that locked itself or lost the site's access", () => {
  it("asks the wallet to unlock, then signs: activity works (the 4100 'not authorized' case)", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const w = wallet(account, { locked: true });
    const a = await loadCore().activity(w.provider, fetchVia(env), { base: BASE_URL, from: account.address });
    expect(a.address).toBe(account.address);
    expect(w.calls).toEqual(["eth_accounts", "eth_requestAccounts", "eth_accounts", "personal_sign"]);
  });

  it("buying works too when the wallet locked after connecting", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const w = wallet(account, { locked: true });
    const s = await loadCore().buySession(w.provider, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: account.address, checkBalance: false });
    expect(s.session_token).toMatch(/^ses_/);
    expect(w.calls).toContain("eth_requestAccounts");
  });

  it("retries once after re-asking when the wallet says 4100 despite listing the account", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const w = wallet(account, { staleOnce: true });
    await loadCore().activity(w.provider, fetchVia(env), { base: BASE_URL, from: account.address });
    expect(w.calls.filter((m) => m === "personal_sign")).toHaveLength(2);
    expect(w.calls).toContain("eth_requestAccounts");
  });

  it("never signs as a different account than the page shows", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const shown = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const w = wallet(shown, { locked: true, unlockAs: other });
    await expect(loadCore().buySession(w.provider, fetchVia(env), { base: BASE_URL, network: NETWORK, size: "usd1", from: shown.address, checkBalance: false })).rejects.toThrow("account_changed");
    expect(w.calls).not.toContain("eth_signTypedData_v4");
    expect(env.facilitator.settled).toHaveLength(0);
  });

  it("if the person won't unlock, nothing is signed", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const account = privateKeyToAccount(generatePrivateKey());
    const w = wallet(account, { locked: true, reject: "eth_requestAccounts" });
    await expect(loadCore().activity(w.provider, fetchVia(env), { base: BASE_URL, from: account.address })).rejects.toMatchObject({ code: 4001 });
    expect(w.calls).not.toContain("personal_sign");
  });
});

describe("wallet sign-in proofs", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const verify = async (address: string, message: string, signature: `0x${string}`) => (await import("viem")).verifyMessage({ address: address as `0x${string}`, message, signature });
  const make = (now = () => Date.parse("2026-11-08T12:00:00Z")) => new WalletSignIn({ secret: "s".repeat(32), baseUrl: "https://gw.test", chainId: 84532, verify, now });

  it("accepts a fresh, signed challenge for the signer's own address", async () => {
    const s = make();
    const c = s.challenge(account.address.toLowerCase()) as { message: string; mac: string };
    expect(c.message).toContain("gw.test wants you to sign in");
    expect(c.message).toContain("does not move funds");
    expect(await s.verify(c.message, c.mac, await account.signMessage({ message: c.message }))).toEqual({ address: account.address });
  });

  it("refuses tampering, expiry, other signers, other servers and junk", async () => {
    let t = Date.parse("2026-11-08T12:00:00Z");
    const s = make(() => t);
    const c = s.challenge(account.address) as { message: string; mac: string };
    const sig = await account.signMessage({ message: c.message });
    const other = privateKeyToAccount(generatePrivateKey());
    // Someone else's address in the message: MAC breaks.
    const swapped = c.message.replace(account.address, other.address);
    expect(await s.verify(swapped, c.mac, await other.signMessage({ message: swapped }))).toEqual({ error: "bad_mac" });
    // Right message, wrong signer.
    expect(await s.verify(c.message, c.mac, await other.signMessage({ message: c.message }))).toEqual({ error: "bad_signature" });
    // Issued by another server (different secret).
    const elsewhere = new WalletSignIn({ secret: "t".repeat(32), baseUrl: "https://gw.test", chainId: 84532, verify, now: () => t });
    expect(await elsewhere.verify(c.message, c.mac, sig)).toEqual({ error: "bad_mac" });
    // Junk.
    expect(await s.verify(c.message, c.mac, "not-hex")).toEqual({ error: "malformed" });
    expect(await s.verify(undefined, c.mac, sig)).toEqual({ error: "malformed" });
    expect(s.challenge("0x123")).toEqual({ error: "invalid_address" });
    // Expired after five minutes.
    t += 5 * 60_000 + 1;
    expect(await s.verify(c.message, c.mac, sig)).toEqual({ error: "expired" });
  });

  it("the activity endpoint refuses an unproven request", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const res = await env.fetch(`${BASE_URL}/v1/wallet/activity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x", mac: "y", signature: "0x00" }) });
    expect(res.status).toBe(401);
  });
});

describe("the /wallet page", () => {
  it("runs exactly the reviewed script, pinned by hash, and nothing else", async () => {
    const env = await createTestEnv({}, { sessions: true });
    const res = await env.fetch(`${BASE_URL}/wallet`, { headers: { accept: BROWSER } });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const script = WALLET_CORE_JS + WALLET_UI_JS;
    expect(csp).toContain(`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(WALLET_CSP).toBe(csp);
    const html = await res.text();
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toMatch(/\son[a-z]+="/i); // no inline handlers
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).toContain('data-size="usd1"');
    // Page text is set with textContent only.
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});
