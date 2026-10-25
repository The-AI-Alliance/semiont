/**
 * Logger interface for observability
 *
 * This interface is intentionally framework-agnostic to work with any logger
 * (winston, pino, bunyan, or simple console).
 *
 * Example usage:
 * ```typescript
 * import winston from 'winston';
 *
 * const logger = winston.createLogger({
 *   level: 'debug',
 *   transports: [new winston.transports.Console()]
 * });
 *
 * const service = new MyService(logger);
 * ```
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(meta: Record<string, unknown>): Logger;
}
