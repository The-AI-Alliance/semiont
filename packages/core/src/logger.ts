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
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  child(meta: Record<string, any>): Logger;
}

/**
 * Serialize an error value into a form that JSON.stringify can handle
 * meaningfully.
 *
 * Winston's default JSON formatter serializes `Error` instances as `{}`
 * because `message`, `stack`, and `name` are non-enumerable properties on
 * the Error prototype. That means `logger.error('x', { error })` with a
 * raw Error argument produces useless log lines like
 * `{"error":{},"message":"x",...}`, throwing away the information you
 * actually need to diagnose the failure.
 *
 * This helper extracts the parts you want to see in a log — name,
 * message, stack, and cause — and leaves non-Error values alone (so
 * strings, numbers, and plain objects pass through unchanged).
 *
 * ## Usage
 *
 * ```ts
 * try {
 *   await doSomething();
 * } catch (error) {
 *   logger.error('Something failed', { error: errField(error) });
 * }
 * ```
 *
 * Use this at every `logger.error` call site that includes an `error`
 * field derived from a catch block. Raw `{ error }` without this helper
 * is almost always a bug.
 */
export function errField(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause !== undefined && { cause: errField(error.cause) }),
    };
  }
  return error;
}
