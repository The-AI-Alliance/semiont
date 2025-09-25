/**
 * Provision Command Tests
 * 
 * Tests the provision command logic using MockPlatformStrategy.
 * Focus: command orchestration and result aggregation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockPlatformInstance, createServiceDeployments, resetMockState } from './_mock-setup';

// Import mocks (side effects)
import './_mock-setup';

describe('Provision Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Basic Functionality', () => {
    it('should execute provision command successfully', async () => {
      const { provisionCommand } = await import('../provision.js');
      const provision = provisionCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options = {
        environment: 'test',
        service: 'backend', // Specify a service to provision
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await provision(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'provision',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number)
      });
    });
  });
});
