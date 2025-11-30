/**
 * Provision Command Tests
 * 
 * Tests the provision command logic using MockPlatformStrategy.
 * Focus: command orchestration and result aggregation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServiceDeployments, resetMockState, createMockEnvConfig } from './_mock-setup';
import type { ProvisionOptions } from '../provision.js';

// Import mocks (side effects)
import './_mock-setup';

// Helper to create complete ProvisionOptions with defaults
function createProvisionOptions(partial: Partial<ProvisionOptions> = {}): ProvisionOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'json',
    forceDiscovery: false,
    all: false,
    force: false,
    skipValidation: false,
    skipDependencies: false,
    destroy: false,
    stack: undefined,
    service: undefined,
    semiontRepo: undefined,
    ...partial
  };
}

describe('Provision Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Basic Functionality', () => {
    it('should execute provision command successfully', async () => {
      const { provision } = await import('../provision.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options = createProvisionOptions({
        service: 'backend',
        output: 'json'
      });

      const result = await provision(serviceDeployments, options, createMockEnvConfig());

      expect(result).toMatchObject({
        command: 'provision',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number)
      });
    });
  });
});
