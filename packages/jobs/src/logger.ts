import winston from 'winston';
import type { Logger } from '@semiont/core';

export function createProcessLogger(component: string): Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  const format = process.env.LOG_FORMAT === 'simple'
    ? winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ level: lvl, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${lvl.toUpperCase()}] [${component}] ${message}${metaStr}`;
        }),
      )
    : winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
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
