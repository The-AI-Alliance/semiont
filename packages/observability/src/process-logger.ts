/**
 * Process-level structured logger for Node entry points.
 *
 * Used by long-lived Node processes (backend, workers, smelter) that
 * want JSON-structured stdout with active-span trace correlation. The
 * `trace_id` / `span_id` fields are populated from the current OTel
 * span context via `getLogTraceContext` — this is the same Tier 3
 * correlation that lets a grep through stdout line up with the trace
 * UI without manual stitching.
 *
 * Reads `LOG_LEVEL` (default `info`) and `LOG_FORMAT` (`json` default,
 * `simple` for human-friendly dev output).
 *
 * Co-located with `getLogTraceContext` deliberately: this is the
 * only reasonably-shaped consumer of that helper, and putting them in
 * the same package keeps the trace-id wiring in one place.
 */

import winston from 'winston';
import type { Logger } from '@semiont/core';
import { getLogTraceContext } from './index.js';

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
