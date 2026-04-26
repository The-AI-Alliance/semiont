import winston from 'winston';
import type { Logger } from '@semiont/core';
import { getLogTraceContext } from '@semiont/observability';

/**
 * Tier 3 trace correlation — tag every log line with the active span's
 * trace_id/span_id when one exists. Cheap no-op otherwise.
 */
const traceContextFormat = winston.format((info) => {
  const trace = getLogTraceContext();
  if (trace) {
    info.trace_id = trace.trace_id;
    info.span_id = trace.span_id;
  }
  return info;
})();

export function createProcessLogger(component: string): Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const format = process.env.LOG_FORMAT === 'simple'
    ? winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        traceContextFormat,
        winston.format.printf(({ level: lvl, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${lvl.toUpperCase()}] [${component}] ${message}${metaStr}`;
        }),
      )
    : winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        traceContextFormat,
        winston.format.json(),
      );

  const logger = winston.createLogger({
    level,
    defaultMeta: { component },
    format,
    transports: [new winston.transports.Console()],
  });

  return logger as unknown as Logger;
}
