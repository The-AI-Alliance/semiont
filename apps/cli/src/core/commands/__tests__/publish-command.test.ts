/**
 * Upublish Command Tests
 * 
 * Tests the publish command logic using MockPlatformStrategy.
 * Focus: command orchestration and result aggregation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServiceDeployments, resetMockState, createMockEnvConfig } from './_mock-setup';
import type { PublishOptions } from '../publish.js';

// Import mocks (side effects)
import './_mock-setup';

// Helper to create complete PublishOptions with defaults
function createPublishOptions(partial: Partial<PublishOptions> = {}): PublishOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'json',
    forceDiscovery: false,
    all: false,
    noCache: false,
    service: undefined,
    tag: undefined,
    registry: undefined,
    semiontRepo: undefined,
    ...partial
  };
}

describe('Upublish Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Basic Functionality', () => {
    it('should execute publish command successfully', async () => {
      const { publish } = await import('../publish.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options = createPublishOptions({
        output: 'json'
      });

      const result = await publish(serviceDeployments, options, createMockEnvConfig());

      expect(result).toMatchObject({
        command: 'publish',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number)
      });
    });
  });
});
