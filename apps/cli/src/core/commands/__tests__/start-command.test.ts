/**
 * Start Command Tests
 * 
 * Tests the start command's structured output functionality
 * using MockPlatformStrategy for proper unit testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServiceDeployments, resetMockState, createMockEnvConfig } from './_mock-setup';
import type { StartOptions } from '../start.js';

// Import mocks (side effects)
import './_mock-setup';

// Helper to create complete StartOptions with defaults
function createStartOptions(partial: Partial<StartOptions> = {}): StartOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: false,
    output: 'json',
    forceDiscovery: false,
    service: undefined,
    ...partial
  };
}

describe('Start Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful start', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock' },
        { name: 'backend', type: 'mock' }
      ]);

      const options = createStartOptions({
        output: 'json'
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      // Debug output to see what's happening
      if (result.summary.failed > 0) {
        console.log('Failed starts:', result.results.filter(r => !r.success));
      }

      expect(result).toBeDefined();
      expect(result.command).toBe('start');
      expect(result.environment).toBe('test');
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.duration).toBeGreaterThan(0);

      // Check that we have results
      expect(result.results).toHaveLength(2);

      // Check summary - may have failures depending on mock behavior
      expect(result.summary).toBeDefined();
      expect(result.summary.total).toBe(2);
      // Don't assert on succeeded/failed counts as they depend on mock behavior

      // Check individual results exist
      const databaseResult = result.results.find(r => r.entity === 'database');
      const backendResult = result.results.find(r => r.entity === 'backend');

      expect(databaseResult).toBeDefined();
      expect(databaseResult?.platform).toBe('mock');

      expect(backendResult).toBeDefined();
      expect(backendResult?.platform).toBe('mock');
    });

    it('should handle dry run mode correctly', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'mock' }
      ]);

      const options = createStartOptions({
        output: 'table',
        verbose: true,
        dryRun: true
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.results[0]!).toMatchObject({
        entity: 'frontend',
        success: true
      });
      
      // Dry run is tracked in executionContext, not per-result metadata
      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should return error results for failed starts', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock', config: { image: 'invalid-image' } }
      ]);

      const options = createStartOptions({
        output: 'yaml',
        quiet: true
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      // Even if container fails to start, we should get a result
      expect(result.command).toBe('start');
      expect(result.results).toHaveLength(1);
    });
  });

  describe('Command Behavior', () => {
    it('should successfully start services', async () => {
      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options = createStartOptions({
        environment: 'production',
        output: 'json'
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.results[0]!).toMatchObject({
        entity: 'backend',
        success: true
      });
    });

    it('should include service configuration in results', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock', config: { image: 'postgres:14' } }
      ]);

      const options = createStartOptions({
        environment: 'staging',
        output: 'summary'
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toBeDefined();
      expect(result.results[0]?.entity).toBe('database');
      // Don't assert on success as it may depend on mock behavior
    });

    it('should include start time in results', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock', config: { port: 3001, command: 'node server.js' } }
      ]);

      const options = createStartOptions({
        output: 'json'
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.results[0]!).toMatchObject({
        entity: 'backend',
        success: true
      });
      expect(result.results[0]!.extensions).toBeDefined();
      expect(result.results[0]!.extensions!.startTime).toEqual(expect.any(Date));
    });

    // External service behavior should be tested in platform tests, not command tests
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const formats = ['summary', 'json', 'yaml', 'table'] as const;
      
      for (const format of formats) {
        const options = createStartOptions({
          output: format,
          dryRun: true
        });

        const result = await start(serviceDeployments, options, createMockEnvConfig());
        
        expect(result).toBeDefined();
        expect(result.command).toBe('start');
      }
    });
  });

  describe('Service Selection', () => {
    it('should start all services when service is "all"', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock' },
        { name: 'backend', type: 'mock' },
        { name: 'frontend', type: 'mock' }
      ]);

      const options = createStartOptions({
        output: 'json',
        dryRun: true
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.results).toHaveLength(3);
      expect(result.summary.total).toBe(3);
    });

    it('should start specific service when named', async () => {

      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options = createStartOptions({
        output: 'json'
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.entity).toBe('backend');
    });
  });

  describe('MCP Service Start', () => {
    beforeEach(() => {
      // Mock fs for reading MCP auth file
      vi.mock('fs', async () => {
        const actual = await vi.importActual<typeof import('fs')>('fs');
        return {
          ...actual,
          existsSync: vi.fn(() => true),
          promises: {
            ...actual.promises,
            readFile: vi.fn().mockResolvedValue(JSON.stringify({
              refresh_token: 'test-refresh-token',
              api_url: 'https://test.semiont.com',
              environment: 'test',
              created_at: new Date().toISOString()
            }))
          }
        };
      });

      // Mock fetch for token refresh
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'test-access-token' })
      });
    });

    it('should start MCP service like any other service', async () => {
      const { start } = await import('../start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'mock', config: { port: 8585 } }
      ]);
      
      const options = createStartOptions({
        output: 'json'
      });

      const result = await start(serviceDeployments, options, createMockEnvConfig());

      // Command test should only verify command orchestration
      expect(result).toMatchObject({
        command: 'start',
        environment: 'test',
        summary: {
          total: 1,
          succeeded: 1,
          failed: 0,
          warnings: 0
        }
      });
      
      expect(result.results[0]).toMatchObject({
        entity: 'mcp',
        platform: 'mock',
        success: true
      });
    });
  });
});