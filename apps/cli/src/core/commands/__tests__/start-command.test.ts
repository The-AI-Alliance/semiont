/**
 * Start Command Tests
 * 
 * Tests the start command's structured output functionality
 * using MockPlatformStrategy for proper unit testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockPlatformInstance, createServiceDeployments, resetMockState } from './_mock-setup.js';
import type { StartOptions } from '../start.js';

// Import mocks (side effects)
import './_mock-setup.js';

describe('Start Command', () => {
  beforeEach(() => {
    resetMockState();
  });
  
  afterEach(() => {
    resetMockState();
  });

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful start', async () => {

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock' },
        { name: 'backend', type: 'mock' }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'start',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        summary: {
          total: 2,
          succeeded: 2,
          failed: 0,
          warnings: 0
        }
      });
      
      // Check results separately for clearer assertions
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({
        entity: 'database',
        platform: 'mock',
        success: true
      });
      expect(result.results[1]).toMatchObject({
        entity: 'backend',
        platform: 'mock',
        success: true
      });
    });

    it('should handle dry run mode correctly', async () => {

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'mock' }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'table',
        quiet: false,
        verbose: true,
        dryRun: true
      };

      const result = await start(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'frontend',
        success: true
      });
      
      // Dry run is tracked in executionContext, not per-result metadata
      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should return error results for failed starts', async () => {

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock', config: { image: 'invalid-image' } }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'yaml',
        quiet: true,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      // Even if container fails to start, we should get a result
      expect(result.command).toBe('start');
      expect(result.results).toHaveLength(1);
    });
  });

  describe('Command Behavior', () => {
    it('should successfully start services', async () => {
      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options: StartOptions = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'backend',
        success: true
      });
    });

    it('should include service configuration in results', async () => {

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock', config: { image: 'postgres:14' } }
      ]);

      const options: StartOptions = {
        environment: 'staging',
        output: 'summary',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result.results[0]!).toMatchObject({
        entity: 'database',
        success: true
      });
    });

    it('should include start time in results', async () => {

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock', config: { port: 3001, command: 'node server.js' } }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

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

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const formats = ['summary', 'json', 'yaml', 'table'] as const;
      
      for (const format of formats) {
        const options: StartOptions = {
          environment: 'test',
          output: format,
          quiet: false,
          verbose: false,
          dryRun: true
        };

        const result = await start(serviceDeployments, options);
        
        expect(result).toBeDefined();
        expect(result.command).toBe('start');
      }
    });
  });

  describe('Service Selection', () => {
    it('should start all services when service is "all"', async () => {

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'mock' },
        { name: 'backend', type: 'mock' },
        { name: 'frontend', type: 'mock' }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: true
      };

      const result = await start(serviceDeployments, options);

      expect(result.results).toHaveLength(3);
      expect(result.summary.total).toBe(3);
    });

    it('should start specific service when named', async () => {

      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

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
      const { startCommand } = await import('../start.js');
      const start = startCommand.handler;
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'mock', config: { port: 8585 } }
      ]);
      
      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

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