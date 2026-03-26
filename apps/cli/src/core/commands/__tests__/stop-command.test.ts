/**
 * Stop Command Tests
 *
 * Tests the stop command's structured output using MockPlatformStrategy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServiceDeployments, resetMockState, createMockEnvConfig, mockPlatformInstance } from './_mock-setup';
import type { StopOptions } from '../stop.js';

// Import mocks (side effects)
import './_mock-setup';

function makeOptions(overrides: Partial<StopOptions> = {}): StopOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    service: undefined,
    force: false,
    timeout: 30,
    ...overrides,
  };
}

describe('Stop Command', () => {
  beforeEach(() => {
    resetMockState();
  });

  afterEach(() => {
    resetMockState();
  });

  it('returns CommandResults structure', async () => {
    const { stop } = await import('../stop.js');

    mockPlatformInstance['mockState'].set('backend', {
      id: 'mock-backend',
      running: true,
      startTime: new Date(),
    });

    const deployments = createServiceDeployments([
      { name: 'backend', type: 'mock' },
    ]);

    const result = await stop(deployments, makeOptions(), createMockEnvConfig());

    expect(result).toBeDefined();
    expect(result.command).toBe('stop');
    expect(result.environment).toBe('test');
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.results).toHaveLength(1);
    expect(result.summary.total).toBe(1);
  });

  it('reports backend entity in results', async () => {
    const { stop } = await import('../stop.js');

    mockPlatformInstance['mockState'].set('backend', {
      id: 'mock-backend',
      running: true,
      startTime: new Date(),
    });

    const deployments = createServiceDeployments([
      { name: 'backend', type: 'mock' },
    ]);

    const result = await stop(deployments, makeOptions(), createMockEnvConfig());
    const backendResult = result.results.find(r => r.entity === 'backend');
    expect(backendResult).toBeDefined();
    expect(backendResult?.platform).toBe('mock');
  });

  it('stops multiple services', async () => {
    const { stop } = await import('../stop.js');

    for (const name of ['frontend', 'backend', 'database']) {
      mockPlatformInstance['mockState'].set(name, {
        id: `mock-${name}`,
        running: true,
        startTime: new Date(),
      });
    }

    const deployments = createServiceDeployments([
      { name: 'frontend', type: 'mock' },
      { name: 'backend', type: 'mock' },
      { name: 'database', type: 'mock' },
    ]);

    const result = await stop(deployments, makeOptions(), createMockEnvConfig());
    expect(result.results).toHaveLength(3);
    expect(result.summary.total).toBe(3);
  });

  it('continues stopping remaining services when one fails', async () => {
    const { stop } = await import('../stop.js');

    mockPlatformInstance['mockState'].set('frontend', {
      id: 'mock-frontend',
      running: true,
      startTime: new Date(),
    });
    // backend: no state (never started — stop should still proceed)

    const deployments = createServiceDeployments([
      { name: 'frontend', type: 'mock' },
      { name: 'backend', type: 'mock' },
    ]);

    const result = await stop(deployments, makeOptions(), createMockEnvConfig());
    // Both should be attempted regardless of individual outcome
    expect(result.results).toHaveLength(2);
    expect(result.summary.succeeded + result.summary.failed).toBe(2);
  });
});
