import { type DatasetSpec, ENV_DATASETS } from "@mx/env";
import { z } from "zod";

const ms = (def: number, min: number) => z.coerce.number().int().min(min).default(def);

export const configSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    NESO_BASE_URL: z.string().url().default("https://api.neso.energy"),
    EA_BASE_URL: z.string().url().default("https://environment.data.gov.uk"),
    /** Metadata check interval. The 5 s floor stops a misconfiguration from hammering a public portal. */
    ENV_CHECK_INTERVAL_MS: ms(30_000, 5_000),
    ENV_MAX_FETCH_INTERVAL_MS: ms(10 * 60_000, 60_000),
    ENV_MAX_BACKOFF_MS: ms(5 * 60_000, 5_000),
    ENV_HTTP_TIMEOUT_MS: ms(10_000, 1_000),
    ENV_PUBLISH_SETTLE_MS: ms(5 * 60_000, 0),
    /**
     * Least gap between two NESO requests from this process, across all datasets. NESO asks for at
     * most 1 per second. The gap is measured at release, and the send follows by under a
     * millisecond, so the floor keeps a 5% margin and the default 10%. The cap is per process: run
     * one replica, with no deploy overlap.
     */
    ENV_MIN_REQUEST_GAP_MS: ms(1_100, 1_050),
    /** Comma-separated dataset ids to poll, or "all". Lets one dataset be switched off without a deploy. */
    ENV_DATASETS: z.string().default("all"),
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
    const r = parseDatasets(c.ENV_DATASETS);
    if (typeof r === "string") ctx.addIssue({ code: "custom", path: ["ENV_DATASETS"], message: r });
  });

export type Config = z.infer<typeof configSchema>;

/** The datasets named by ENV_DATASETS, in ENV_DATASETS order, or an error message. */
export function parseDatasets(v: string): DatasetSpec[] | string {
  if (v.trim() === "all") return [...ENV_DATASETS];
  const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return 'name at least one dataset, or "all"';
  const known = new Set(ENV_DATASETS.map((d) => d.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) return `unknown dataset ${unknown.join(", ")} (known: ${[...known].join(", ")})`;
  return ENV_DATASETS.filter((d) => ids.includes(d.id));
}

/** The datasets to poll, from a config that passed validation. */
export function selectedDatasets(c: Config): DatasetSpec[] {
  return parseDatasets(c.ENV_DATASETS) as DatasetSpec[];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = configSchema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${issues}`);
  }
  return r.data;
}
