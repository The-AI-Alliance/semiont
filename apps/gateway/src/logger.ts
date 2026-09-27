/**
 * Core Logger Module
 *
 * Winston-based logging with configurable log levels and structured metadata.
 * Supports environment-based configuration for development and production.
 */

import winston from 'winston';
import { getLogTraceContext } from '@semiont/observability';

/**
 * Winston format that injects the active OTel span's trace_id/span_id
 * into every log line — Tier 3 of OBSERVABILITY.md. Cheap when no SDK
 * is initialized (returns undefined immediately). Lets operators jump
 * from a log line in their aggregator to the trace in their APM.
 */
const traceContextFormat = winston.format((info) => {
  const trace = getLogTraceContext();
  if (trace) {
    info.trace_id = trace.trace_id;
    info.span_id = trace.span_id;
  }
  return info;
})();

/**
 * Log levels supported by the logger
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'debug';

/**
 * Logger configuration options
 */
export interface LoggerConfig {
  level: LogLevel;
  format: 'json' | 'simple';
}

/**
 * The logger's configuration: the level from the configuration document, and
 * LOG_FORMAT from the environment (json | simple; json when unset). Logs go
 * to stdout, the container's contract — `semiont logs` reads the runtime's
 * stream.
 */
function getLoggerConfig(level: LogLevel): LoggerConfig {
  const format = (process.env.LOG_FORMAT || 'json') as 'json' | 'simple';
  return { level, format };
}

/**
 * Create Winston format based on configuration
 */
function createFormat(config: LoggerConfig): winston.Logform.Format {
  if (config.format === 'json') {
    return winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      traceContextFormat,
      winston.format.json()
    );
  }

  // Simple format for development
  return winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    traceContextFormat,
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  );
}

/**
 * Global Winston logger instance
 */
let loggerInstance: winston.Logger | null = null;

/**
 * Initialize the global logger
 * Call this once at application startup
 *
 * @param logLevel - The configuration document's level
 */
export function initializeLogger(logLevel: LogLevel): winston.Logger {
  const config = getLoggerConfig(logLevel);

  loggerInstance = winston.createLogger({
    level: config.level,
    format: createFormat(config),
    transports: [new winston.transports.Console({ level: config.level })],
    // Don't exit on handled exceptions
    exitOnError: false
  });

  loggerInstance.info('Logger initialized', {
    level: config.level,
    format: config.format,
  });

  return loggerInstance;
}

/**
 * Get the global logger instance
 * Throws if logger hasn't been initialized
 */
export function getLogger(): winston.Logger {
  if (!loggerInstance) {
    throw new Error('Logger not initialized. Call initializeLogger() first.');
  }
  return loggerInstance;
}

/**
 * Create a child logger with additional context
 *
 * @param context - Additional context fields to include in all log messages
 * @returns Child logger with context
 *
 * @example
 * ```typescript
 * const logger = createChildLogger({ userId: '123', requestId: 'abc' });
 * logger.info('User logged in'); // Will include userId and requestId
 * ```
 */
export function createChildLogger(context: Record<string, any>): winston.Logger {
  return getLogger().child(context);
}

/**
 * Create a logger for a specific component/service
 *
 * @param component - Component name (e.g., 'auth', 'storage', 'api')
 * @returns Child logger with component context
 *
 * @example
 * ```typescript
 * const logger = createComponentLogger('storage');
 * logger.info('File saved successfully', { path: '/tmp/file.txt' });
 * // Output: { component: 'storage', message: 'File saved successfully', path: '/tmp/file.txt' }
 * ```
 */
export function createComponentLogger(component: string): winston.Logger {
  return createChildLogger({ component });
}
