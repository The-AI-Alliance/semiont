/**
 * Logger tests
 *
 * Basic smoke tests to ensure Winston logger is working correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
});
