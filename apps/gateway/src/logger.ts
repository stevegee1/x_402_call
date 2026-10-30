import { pino } from "pino";

export const createLogger = (level = "info") =>
  pino({
    level,
    base: { service: "gateway" },
    redact: {
      paths: ["req.headers.authorization", "req.headers['payment-signature']", "apiKey", "*.apiKey", "secret"],
      censor: "[redacted]",
    },
  });

export type Logger = ReturnType<typeof createLogger>;
