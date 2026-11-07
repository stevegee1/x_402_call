import { z } from "zod";

const ms = (def: number, min: number) => z.coerce.number().int().min(min).default(def);

export const configSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    NESO_BASE_URL: z.string().url().default("https://api.neso.energy"),
    /** Metadata check interval. The 5 s floor stops a misconfiguration from hammering a public portal. */
    ENV_CHECK_INTERVAL_MS: ms(30_000, 5_000),
    ENV_MAX_FETCH_INTERVAL_MS: ms(10 * 60_000, 60_000),
    ENV_MAX_BACKOFF_MS: ms(5 * 60_000, 5_000),
    ENV_HTTP_TIMEOUT_MS: ms(10_000, 1_000),
    ENV_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8091),
    LOG_LEVEL: z.string().default("info"),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && !c.NESO_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["NESO_BASE_URL"], message: "must be https in production" });
    }
    if (c.ENV_MAX_FETCH_INTERVAL_MS < c.ENV_CHECK_INTERVAL_MS) {
      ctx.addIssue({ code: "custom", path: ["ENV_MAX_FETCH_INTERVAL_MS"], message: "must be at least ENV_CHECK_INTERVAL_MS" });
    }
    if (c.ENV_MAX_BACKOFF_MS < c.ENV_CHECK_INTERVAL_MS) {
      ctx.addIssue({ code: "custom", path: ["ENV_MAX_BACKOFF_MS"], message: "must be at least ENV_CHECK_INTERVAL_MS" });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = configSchema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${issues}`);
  }
  return r.data;
}
