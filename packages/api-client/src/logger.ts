/**
 * Logger interface for API client observability
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
 * const client = new SemiontApiClient({
 *   baseUrl: 'http://localhost:4000',
 *   logger
 * });
 * ```
 */
export interface Logger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}
