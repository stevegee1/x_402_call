import { pino } from "pino";

export const createLogger = (level = "info") =>
  pino({
    level,
    base: { service: "facilitator" },
    redact: { paths: ["req.headers.authorization", "FACILITATOR_PRIVATE_KEY", "*.FACILITATOR_PRIVATE_KEY", "AUTH_TOKEN"], censor: "[redacted]" },
  });
