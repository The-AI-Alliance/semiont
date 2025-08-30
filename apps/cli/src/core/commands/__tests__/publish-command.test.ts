/**
 * Upublish Command Tests
 * 
 * Tests the publish command logic using MockPlatformStrategy.
 * Focus: command orchestration and result aggregation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockPlatformInstance, createServiceDeployments, resetMockState } from './_mock-setup.js';

// Import mocks (side effects)
import './_mock-setup.js';

describe('Upublish Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Basic Functionality', () => {
    it('should execute publish command successfully', async () => {
      const { publishCommand } = await import('../publish.js');
      const publish = publishCommand.handler;
      
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

      const result = await publish(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'publish',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number)
      });
    });
  });
});
