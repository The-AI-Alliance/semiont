/**
 * Uwatch Command Tests
 * 
 * Tests the watch command logic using MockPlatformStrategy.
 * Focus: command orchestration and result aggregation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServiceDeployments, resetMockState } from './_mock-setup';

// Import mocks (side effects)
import './_mock-setup';

describe('Uwatch Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Basic Functionality', () => {
    it('should execute watch command successfully', async () => {
      const { watchCommand } = await import('../watch.js');
      const watch = watchCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await watch(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'watch',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number)
      });
    });
  });
});
