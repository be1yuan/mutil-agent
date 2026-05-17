import { createLogger, format, transports } from "winston";
import type { ObservabilityConfig } from "../config/types.js";

// ── Logger factory ──

export function createAppLogger(config: ObservabilityConfig) {
  return createLogger({
    level: config.logLevel,
    format: format.combine(
      format.timestamp(),
      format.errors({ stack: true }),
      format.json()
    ),
    defaultMeta: { service: "multi-agent-orchestrator" },
    transports: [
      new transports.Console({
        level: "warn",
        format: format.combine(
          format.colorize(),
          format.printf(({ level, message, timestamp, ...meta }) => {
            const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : "";
            return `${timestamp} [${level}]: ${message} ${metaStr}`;
          })
        ),
      }),
      new transports.File({ filename: "logs/error.log", level: "error" }),
      new transports.File({ filename: "logs/combined.log" }),
    ],
  });
}

// Singleton logger instance (set during init)
let _logger: ReturnType<typeof createAppLogger> | null = null;

export function setLogger(logger: ReturnType<typeof createAppLogger>): void {
  _logger = logger;
}

export function getLogger(): ReturnType<typeof createAppLogger> {
  if (!_logger) {
    // Fallback console logger before init
    return createAppLogger({ logLevel: "info", metricsEnabled: false });
  }
  return _logger;
}
