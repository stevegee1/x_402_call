import { z } from "zod";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x EVM address");

/** Chain id each supported CAIP-2 network must report; the service refuses to start on a mismatch. */
export const NETWORK_CHAIN_IDS = { "eip155:8453": 8453, "eip155:84532": 84532 } as const;
export type SupportedNetwork = keyof typeof NETWORK_CHAIN_IDS;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(8090),
    LOG_LEVEL: z.string().default("info"),

    NETWORK: z.enum(["eip155:8453", "eip155:84532"]).default("eip155:84532"),
    RPC_URL: z.string().url(),
    /** Hot wallet that pays gas to submit EIP-3009 authorisations. It never holds customer funds. */
    FACILITATOR_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte hex key"),
    /** Bearer token the gateway sends. Without it anyone could spend our gas relaying their payments. */
    AUTH_TOKEN: z.string().min(24, "AUTH_TOKEN must be at least 24 chars").optional(),
    /** Comma-separated payTo addresses we will settle to: defence in depth behind AUTH_TOKEN. */
    ALLOWED_PAY_TO: z
      .string()
      .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(address).min(1, "at least one payTo address is required"))
      .transform((xs) => new Set(xs.map((x) => x.toLowerCase()))),
    /** Readiness fails below this gas balance, so traffic drains to the primary before settles start failing. */
    MIN_GAS_BALANCE_WEI: z.coerce.bigint().default(1_000_000_000_000_000n), // 0.001 ETH
    /** Bound on each receipt wait; keep it below the gateway's FACILITATOR_TIMEOUT_MS budget for settle. */
    CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && !c.AUTH_TOKEN) ctx.addIssue({ code: "custom", path: ["AUTH_TOKEN"], message: "required in production" });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  return r.data;
}
