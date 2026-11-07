import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Session tokens: `ses_<paymentId>.<mac>`, where mac = HMAC-SHA256(secret, paymentId), base64url.
 * Verifying one is a single HMAC, a few microseconds, with no lookup. The token carries no balance
 * or expiry: those live with the session, so a token can't be edited into more value.
 */
const PREFIX = "ses_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SessionTokens {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("session secret must be at least 32 characters");
    this.key = Buffer.from(secret, "utf8");
  }

  private mac(paymentId: string): Buffer {
    return createHmac("sha256", this.key).update(`x402-session:${paymentId}`).digest();
  }

  issue(paymentId: string): string {
    if (!UUID.test(paymentId)) throw new Error("session id must be a payment uuid");
    return `${PREFIX}${paymentId}.${this.mac(paymentId).toString("base64url")}`;
  }

  /** The session id if the token is genuine, else null. Constant-time on the MAC. */
  verify(token: string): string | null {
    if (!token.startsWith(PREFIX)) return null;
    const dot = token.indexOf(".", PREFIX.length);
    if (dot < 0) return null;
    const id = token.slice(PREFIX.length, dot);
    if (!UUID.test(id)) return null;
    let given: Buffer;
    try {
      given = Buffer.from(token.slice(dot + 1), "base64url");
    } catch {
      return null;
    }
    const want = this.mac(id);
    return given.length === want.length && timingSafeEqual(given, want) ? id : null;
  }
}
