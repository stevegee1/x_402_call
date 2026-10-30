import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "mk_";

/** API keys are shown once; only a SHA-256 hash is stored. */
export function generateApiKey(env: "live" | "test"): { key: string; hash: string; prefix: string } {
  const key = `${API_KEY_PREFIX}${env}_${randomBytes(24).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

export const looksLikeApiKey = (v: string) => /^mk_(live|test)_[A-Za-z0-9_-]{32}$/.test(v);
