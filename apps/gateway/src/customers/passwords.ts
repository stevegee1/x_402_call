import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (node:crypto, no native add-ons). Parameters follow the OWASP
 * Password Storage Cheat Sheet's equivalent-strength table: N=2^14, r=8, p=5 (16 MiB per hash),
 * chosen over N=2^17 so a burst of sign-ins can't exhaust a small container's memory.
 * Stored as `scrypt$<log2 N>$<r>$<p>$<salt b64url>$<hash b64url>`, so parameters can be raised
 * later and old hashes still verify.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
const KEYLEN = 32;
export const CURRENT = { logN: 14, r: 8, p: 5 } as const;

const scrypt = (pw: string, salt: Buffer, opts: ScryptOptions) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pw.normalize("NFKC"), salt, KEYLEN, opts, (e, k) => (e ? fail(e) : ok(k))));

const params = (logN: number, r: number, p: number): ScryptOptions => ({ N: 2 ** logN, r, p, maxmem: 2 * 128 * 2 ** logN * r + 1024 * 1024 });

/** Length only, per NIST SP 800-63B: no composition rules. Returns an error message or null. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string") return "Enter a password.";
  const n = [...pw.normalize("NFKC")].length;
  if (n < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (n > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const { logN, r, p } = CURRENT;
  const key = await scrypt(pw, salt, params(logN, r, p));
  return `scrypt$${logN}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time on the derived key. A malformed stored hash never verifies. */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return false;
  const [logN, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const want = Buffer.from(m[5]!, "base64url");
  if (want.length !== KEYLEN) return false;
  const got = await scrypt(pw, Buffer.from(m[4]!, "base64url"), params(logN, r, p));
  return timingSafeEqual(got, want);
}

