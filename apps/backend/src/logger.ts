/**
 * Core Logger Module
 *
 * Winston-based logging with configurable log levels and structured metadata.
 * Supports environment-based configuration for development and production.
 */

import winston from 'winston';

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
  transports: ('console' | 'file')[];
}

/**
 * Get logger configuration from environment config or environment variables
 *
 * Priority:
 * 1. Provided logLevel parameter (from environment config)
 * 2. LOG_LEVEL environment variable
 * 3. Default: 'info'
 *
 * Environment variables:
 * - LOG_LEVEL: error | warn | info | http | debug (fallback if no config provided)
 * - LOG_FORMAT: json | simple (default: json)
 * - NODE_ENV: development | production | test
 */
export function getLoggerConfig(logLevel?: LogLevel): LoggerConfig {
  const level = logLevel || (process.env.LOG_LEVEL as LogLevel) || 'info';
  const format = (process.env.LOG_FORMAT || 'json') as 'json' | 'simple';
  const nodeEnv = process.env.NODE_ENV || 'development';

  // In test mode, only use console transport with minimal logging
  if (nodeEnv === 'test') {
    return {
      level: 'error', // Only log errors in tests
      format: 'simple',
      transports: ['console']
    };
  }

  return {
    level,
    format,
    transports: ['console', 'file']
  };
}

/**
 * Create Winston format based on configuration
 */
function createFormat(config: LoggerConfig): winston.Logform.Format {
  if (config.format === 'json') {
    return winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );
  }

  // Simple format for development
  return winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  );
}

/**
 * Create Winston transports based on configuration
 */
function createTransports(config: LoggerConfig): winston.transport[] {
  const transports: winston.transport[] = [];

  if (config.transports.includes('console')) {
    transports.push(
      new winston.transports.Console({
        level: config.level
      })
    );
  }

  if (config.transports.includes('file')) {
    // Separate files for different log levels
    transports.push(
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error'
      }),
      new winston.transports.File({
        filename: 'logs/combined.log',
        level: config.level
      })
    );
  }

  return transports;
}

/**
 * Global Winston logger instance
 */
let loggerInstance: winston.Logger | null = null;

/**
 * Initialize the global logger
 * Call this once at application startup
 *
 * @param logLevel - Optional log level from environment config
 */
export function initializeLogger(logLevel?: LogLevel): winston.Logger {
  const config = getLoggerConfig(logLevel);

  loggerInstance = winston.createLogger({
    level: config.level,
    format: createFormat(config),
    transports: createTransports(config),
    // Don't exit on handled exceptions
    exitOnError: false
  });

  loggerInstance.info('Logger initialized', {
    level: config.level,
    format: config.format,
    transports: config.transports
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
