import { createHash, randomBytes } from "node:crypto";
import { generateApiKey } from "../credits/keys";
import { CreditsError, type CreditsService } from "../credits/service";
import type { ApiKeyInfo, CreditAccount, CustomerUser, Store } from "../store/types";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords";

export interface CustomerPolicy {
  sessionTtlMs: number;
  /** Failed sign-ins before the user is locked out for lockMs. Counted in the database, so per user across replicas. */
  maxFailures: number;
  lockMs: number;
}

export const DEFAULT_CUSTOMER_POLICY: CustomerPolicy = { sessionTtlMs: 14 * 86_400_000, maxFailures: 10, lockMs: 15 * 60_000 };

export type SignInResult = { ok: true; token: string; expiresAt: Date } | { ok: false; reason: "invalid" | "locked"; retryAt?: Date };

/** A fixed, valid hash to verify against when the email is unknown, so timing doesn't reveal which emails exist. */
let DUMMY_HASH: Promise<string> | undefined;
const dummyHash = () => (DUMMY_HASH ??= hashPassword(randomBytes(18).toString("base64url")));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normEmail = (e: unknown) => (typeof e === "string" ? e.trim() : "");

/**
 * Browser sign-in for credit-account customers. The session token is 32 random bytes in an
 * HttpOnly cookie; only its SHA-256 is stored, so a database leak can't be replayed as sessions.
 */
export class CustomerAccounts {
  constructor(
    private readonly store: Store,
    private readonly credits: CreditsService,
    private readonly keyEnv: "live" | "test",
    readonly policy: CustomerPolicy = DEFAULT_CUSTOMER_POLICY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Validates like the API sign-up (company, email, country, tax id) plus a password. Throws CreditsError with a field code. */
  async signUp(input: { company: unknown; email: unknown; country: unknown; taxId: unknown; password: unknown }): Promise<{ account: CreditAccount; user: CustomerUser; apiKey: string; token: string; expiresAt: Date }> {
    const pwErr = passwordProblem(input.password);
    if (pwErr) throw new CreditsError("invalid_password", pwErr);
    const account = this.credits.normalizeAccount({ company: input.company as string, email: input.email as string, country: input.country as string, taxId: (input.taxId as string) || null });
    const { key, hash, prefix } = generateApiKey(this.keyEnv);
    const created = await this.store.createCustomer(account, { email: account.email, passwordHash: await hashPassword(input.password as string) }, { hash, prefix });
    if (created === "email_taken") throw new CreditsError("email_taken", "An account with this email already exists. Sign in instead.", 409);
    const session = await this.startSession(created.user.id);
    return { ...created, apiKey: key, ...session };
  }

  async signIn(email: unknown, password: unknown): Promise<SignInResult> {
    const e = normEmail(email);
    const pw = typeof password === "string" ? password : "";
    const user = e ? await this.store.customerByEmail(e) : null;
    if (!user) {
      await verifyPassword(pw, await dummyHash());
      return { ok: false, reason: "invalid" };
    }
    const now = new Date(this.now());
    if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: "locked", retryAt: user.lockedUntil };
    if (!(await verifyPassword(pw, user.passwordHash))) {
      await this.store.recordLoginFailure(user.id, now, this.policy.maxFailures, this.policy.lockMs);
      return { ok: false, reason: "invalid" };
    }
    await this.store.recordLoginSuccess(user.id, now);
    return { ok: true, ...(await this.startSession(user.id)) };
  }

  private async startSession(userId: string) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + this.policy.sessionTtlMs);
    await this.store.createWebSession(sha256(token), userId, expiresAt);
    return { token, expiresAt };
  }

  async session(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.store.webSession(sha256(token), new Date(this.now()));
  }

  async signOut(token: string | undefined) {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) await this.store.revokeWebSession(sha256(token));
  }

  keys(accountId: string): Promise<ApiKeyInfo[]> {
    return this.store.listApiKeys(accountId);
  }

  /** A new API key for the account, shown once. */
  async createKey(accountId: string): Promise<{ key: string; info: ApiKeyInfo }> {
    const { key, hash, prefix } = generateApiKey(this.keyEnv);
    return { key, info: await this.store.addApiKey(accountId, hash, prefix) };
  }

  /** Revokes a key. This replica stops accepting it at once; others within the credits key-cache TTL. */
  async revokeKey(accountId: string, keyId: string): Promise<boolean> {
    const ok = await this.store.revokeApiKey(accountId, keyId);
    if (ok) this.credits.forgetKeys();
    return ok;
  }
}
