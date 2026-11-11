import { pino } from "pino";

export const createLogger = (level = "info") =>
  pino({
    level,
    base: { service: "gas-keeper" },
    redact: { paths: ["KEEPER_PRIVATE_KEY", "*.KEEPER_PRIVATE_KEY"], censor: "[redacted]" },
  });
