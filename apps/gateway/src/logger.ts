/**
 * Core Logger Module
 *
 * Winston-based logging with structured metadata, at the level and in the
 * format the configuration document names. Logs go to stdout, the container's
 * contract — `semiont logs` reads the runtime's stream.
 */

import winston from 'winston';
import { getLogTraceContext } from '@semiont/observability';
import type { GatewayConfig } from './config';

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

/** The document's logging fields. */
type LoggingSettings = Pick<GatewayConfig, 'logLevel' | 'logFormat'>;

function createFormat(format: GatewayConfig['logFormat']): winston.Logform.Format {
  if (format === 'json') {
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
 */
export function initializeLogger({ logLevel, logFormat }: LoggingSettings): winston.Logger {
  loggerInstance = winston.createLogger({
    level: logLevel,
    format: createFormat(logFormat),
    transports: [new winston.transports.Console({ level: logLevel })],
    // Don't exit on handled exceptions
    exitOnError: false
  });

  loggerInstance.info('Logger initialized', { level: logLevel, format: logFormat });

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
