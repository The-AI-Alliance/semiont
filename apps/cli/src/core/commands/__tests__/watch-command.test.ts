/**
 * Uwatch Command Tests
 * 
 * Tests the watch command logic using MockPlatformStrategy.
 * Focus: command orchestration and result aggregation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServiceDeployments, resetMockState, createMockEnvConfig } from './_mock-setup';
import type { WatchOptions } from '../watch.js';

// Import mocks (side effects)
import './_mock-setup';

// Helper to create complete WatchOptions with defaults
function createWatchOptions(partial: Partial<WatchOptions> = {}): WatchOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'json',
    forceDiscovery: false,
    target: 'all',
    noFollow: false,
    interval: 30,
    terminal: false,
    term: undefined,
    port: 3333,
    service: undefined,
    ...partial
  };
}

describe('Uwatch Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Basic Functionality', () => {
    it('should execute watch command successfully', async () => {
      const { watch } = await import('../watch.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process' }
      ]);

      const options = createWatchOptions({
        output: 'json'
      });

      const result = await watch(serviceDeployments, options, createMockEnvConfig());

      expect(result).toMatchObject({
        command: 'watch',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number)
      });
    });
  });
});
