/**
 * Logger tests
 *
 * Basic smoke tests to ensure Winston logger is working correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { initializeLogger, getLogger, createComponentLogger, createChildLogger } from '../logger';

describe('Logger', () => {
  beforeEach(() => {
    // Initialize logger for tests
    initializeLogger();
  });

  it('should initialize logger successfully', () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.debug).toBeDefined();
  });

  it('should create component logger with context', () => {
    const logger = createComponentLogger('test-component');
    expect(logger).toBeDefined();

    // Smoke test - ensure it doesn't throw
    logger.info('Test message');
  });

  it('should create child logger with custom context', () => {
    const logger = createChildLogger({ requestId: 'test-123', userId: 'user-456' });
    expect(logger).toBeDefined();

    // Smoke test - ensure it doesn't throw
    logger.info('Test message with context');
  });

  it('should log at different levels', () => {
    const logger = getLogger();

    // Smoke tests - ensure none throw
    logger.error('Error message');
    logger.warn('Warning message');
    logger.info('Info message');
    logger.debug('Debug message');
  });

  // File logging is opt-in on LOG_DIR.
  //
  // It used to be unconditional outside tests, with `LOG_DIR ?? 'logs'` — a
  // RELATIVE fallback. The retired CLI always set LOG_DIR (to its state dir), so
  // the fallback never fired. Once the CLI went, the container ran with LOG_DIR
  // unset and WORKDIR /kb, so winston created /kb/logs/ — inside the user's
  // knowledge base, which is a git repo they commit. Verified against a real
  // container before this test was written.
  //
  // It was also redundant: the container logs to stdout, which is what
  // `semiont logs` reads.
  describe('file transport', () => {
    const saved = process.env.LOG_DIR;
    const savedEnv = process.env.NODE_ENV;

    beforeEach(() => {
      // The transport choice is skipped entirely under NODE_ENV=test, so these
      // cases must run as a non-test environment to exercise the real branch.
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      if (saved === undefined) delete process.env.LOG_DIR;
      else process.env.LOG_DIR = saved;
      if (savedEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv;
    });

    it('adds no file transport when LOG_DIR is unset', () => {
      delete process.env.LOG_DIR;
      const kinds = transportKinds();
      expect(kinds).toContain('Console');
      expect(kinds).not.toContain('File');
    });

    it('adds file transports when LOG_DIR is set', () => {
      process.env.LOG_DIR = tmpdir();
      expect(transportKinds()).toContain('File');
    });
  });
});

/** The constructor names of the transports the logger is currently built with. */
function transportKinds(): string[] {
  initializeLogger();
  return getLogger().transports.map(t => t.constructor.name);
}
