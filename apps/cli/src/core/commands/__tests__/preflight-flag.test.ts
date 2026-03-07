/**
 * Preflight Flag Tests
 *
 * Tests the --preflight plumbing in MultiServiceExecutor:
 * - When --preflight is passed, handlers' preflight() functions run instead of the handler
 * - Failed preflights produce success: false results (which triggers non-zero exit)
 * - nextCommand chain preflights are advisory only (do not affect results)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServiceDeployments, resetMockState, createMockEnvConfig } from './_mock-setup';
import type { StartOptions } from '../start.js';
import type { CheckOptions } from '../check.js';

// Import mocks (side effects)
import './_mock-setup';

function createStartOptions(partial: Partial<StartOptions> = {}): StartOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    service: undefined,
    ...partial,
  };
}

function createCheckOptions(partial: Partial<CheckOptions> = {}): CheckOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    service: undefined,
    all: false,
    deep: true,
    wait: false,
    ...partial,
  };
}

describe('--preflight flag', () => {
  beforeEach(() => {
    resetMockState();
  });

  afterEach(() => {
    resetMockState();
  });

  describe('preflight-only mode', () => {
    it('should run preflights instead of handlers when preflight=true', async () => {
      const { start } = await import('../start.js');

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' },
      ]);

      const options = createStartOptions({ preflight: true });
      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.command).toBe('start');
      expect(result.environment).toBe('test');
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.duration).toBeGreaterThanOrEqual(0);

      // Preflight-only mode sets dryRun: true in executionContext
      expect(result.executionContext.dryRun).toBe(true);

      // Mock platform's start handler has passingPreflight()
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        entity: 'backend',
        platform: 'mock',
        success: true,
      });
      expect(result.summary.succeeded).toBe(1);
      expect(result.summary.failed).toBe(0);
    });

    it('should run preflights for multiple services', async () => {
      const { start } = await import('../start.js');

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' },
        { name: 'frontend', type: 'mock' },
        { name: 'database', type: 'mock', config: { port: 5432 } },
      ]);

      const options = createStartOptions({ preflight: true });
      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.results).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      expect(result.summary.succeeded).toBe(3);
      expect(result.summary.failed).toBe(0);
    });

    it('should work with check command too', async () => {
      const { check } = await import('../check.js');

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' },
      ]);

      const options = createCheckOptions({ preflight: true });
      const result = await check(serviceDeployments, options, createMockEnvConfig());

      expect(result.command).toBe('check');
      expect(result.executionContext.dryRun).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.success).toBe(true);
    });

    it('should not execute the actual handler in preflight mode', async () => {
      const { start } = await import('../start.js');

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' },
      ]);

      // First run with preflight=true
      const preflightResult = await start(
        serviceDeployments,
        createStartOptions({ preflight: true }),
        createMockEnvConfig()
      );

      // The mock start handler sets mockState when it runs.
      // In preflight-only mode, no handler should have run,
      // so metadata should not contain the mock handler's startTime/endpoint etc.
      const r = preflightResult.results[0];
      expect(r?.success).toBe(true);
      // Preflight results have preflight: true in metadata
      expect(r?.metadata?.preflight).toBe(true);
    });
  });

  describe('normal execution (preflight=false)', () => {
    it('should execute the actual handler when preflight=false', async () => {
      const { start } = await import('../start.js');

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' },
      ]);

      const options = createStartOptions({ preflight: false });
      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.command).toBe('start');
      expect(result.executionContext.dryRun).toBe(false);

      // The mock handler runs and returns extensions like startTime
      const r = result.results[0];
      expect(r?.success).toBe(true);
      expect(r?.extensions?.startTime).toBeInstanceOf(Date);
    });
  });

  describe('summary counts for exit code behavior', () => {
    it('should have failed=0 when all preflights pass (exit code 0)', async () => {
      const { start } = await import('../start.js');

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' },
      ]);

      const result = await start(
        serviceDeployments,
        createStartOptions({ preflight: true }),
        createMockEnvConfig()
      );

      // When all preflights pass, summary.failed is 0
      // command-executor.ts only calls process.exit(1) when summary.failed > 0
      expect(result.summary.failed).toBe(0);
    });
  });
});
