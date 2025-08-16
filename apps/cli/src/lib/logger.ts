/**
 * Secure, structured logging utility for Semiont scripts
 * Prevents sensitive data exposure and provides consistent output
 */

import chalk from 'chalk';
import { LogLevel } from './types.js';

// Sensitive data patterns to redact
const SENSITIVE_PATTERNS = [
  /\b[A-Za-z0-9]{20,}\b/g, // Potential API keys/tokens
  /password[=:]\s*[^\s]+/gi,
  /secret[=:]\s*[^\s]+/gi,
  /token[=:]\s*[^\s]+/gi,
  /key[=:]\s*[^\s]+/gi,
  /\b\w+@\w+\.\w+\b/g, // Email addresses (partial redact)
];

export class Logger {
  private logLevel: LogLevel;
  private context: Record<string, any>;

  constructor(logLevel: LogLevel = 'info', context: Record<string, any> = {}) {
    this.logLevel = logLevel;
    this.context = context;
  }

  /**
   * Redact sensitive information from log messages
   */
  private redactSensitive(message: string): string {
    let redacted = message;
    
    SENSITIVE_PATTERNS.forEach(pattern => {
      redacted = redacted.replace(pattern, (match) => {
        if (match.length <= 8) return '[REDACTED]';
        return match.substring(0, 4) + '[REDACTED]' + match.substring(match.length - 4);
      });
    });
    
    return redacted;
  }

  /**
   * Format log message with timestamp and level
   */
  private formatMessage(level: LogLevel, message: string, context?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const levelIcon = this.getLevelIcon(level);
    const colorFn = this.getLevelColor(level);
    
    const contextStr = context ? ` ${JSON.stringify(context, null, 2)}` : '';
    return colorFn(`${levelIcon} [${timestamp}] ${message}${contextStr}`);
  }

  private getLevelIcon(level: LogLevel): string {
    switch (level) {
      case 'debug': return '🔍';
      case 'info': return 'ℹ️';
      case 'warn': return '⚠️';
      case 'error': return '❌';
      default: return 'ℹ️';
    }
  }

  private getLevelColor(level: LogLevel): (text: string) => string {
    switch (level) {
      case 'debug': return chalk.gray;
      case 'info': return chalk.blue;
      case 'warn': return chalk.yellow;
      case 'error': return chalk.red;
      default: return chalk.white;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentIndex = levels.indexOf(this.logLevel);
    const messageIndex = levels.indexOf(level);
    return messageIndex >= currentIndex;
  }

  debug(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('debug')) {
      const safeMessage = this.redactSensitive(message);
      console.log(this.formatMessage('debug', safeMessage, { ...this.context, ...context }));
    }
  }

  info(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('info')) {
      const safeMessage = this.redactSensitive(message);
      console.log(this.formatMessage('info', safeMessage, { ...this.context, ...context }));
    }
  }

  warn(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('warn')) {
      const safeMessage = this.redactSensitive(message);
      console.warn(this.formatMessage('warn', safeMessage, { ...this.context, ...context }));
    }
  }

  error(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('error')) {
      const safeMessage = this.redactSensitive(message);
      console.error(this.formatMessage('error', safeMessage, { ...this.context, ...context }));
    }
  }

  /**
   * Simple console output without timestamps (for user-facing messages)
   */
  simple(message: string, level: LogLevel = 'info'): void {
    const colorFn = this.getLevelColor(level);
    const safeMessage = this.redactSensitive(message);
    console.log(colorFn(safeMessage));
  }

  /**
   * Create a child logger with additional context
   */
  child(additionalContext: Record<string, any>): Logger {
    return new Logger(this.logLevel, { ...this.context, ...additionalContext });
  }

  /**
   * Set log level dynamically
   */
  setLevel(level: LogLevel): void {
    this.logLevel = level;
  }
}

// Default logger instance
export const logger = new Logger(
  (process.env.LOG_LEVEL as LogLevel) || 'info',
  { script: process.argv[1]?.split('/').pop() || 'unknown' }
);

// Convenience functions
export const log = {
  debug: (msg: string, ctx?: Record<string, any>) => logger.debug(msg, ctx),
  info: (msg: string, ctx?: Record<string, any>) => logger.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, any>) => logger.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, any>) => logger.error(msg, ctx),
  simple: (msg: string, level?: LogLevel) => logger.simple(msg, level),
};