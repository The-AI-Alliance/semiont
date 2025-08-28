/**
 * Start Command Tests
 * 
 * Tests the start command's structured output functionality across
 * different deployment types (aws, container, process, external).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StartOptions } from '../commands/start.js';
import type { ServicePlatformInfo } from '../platforms/platform-resolver.js';

// Mock the container runtime to avoid actual Docker calls
vi.mock('../platforms/container-runtime.js', () => ({
  runContainer: vi.fn().mockResolvedValue(true),
  stopContainer: vi.fn().mockResolvedValue(true)
}));

// Mock child_process to avoid spawning real processes
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() }
  }))
}));

// Mock fs.promises for filesystem operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined)
    }
  };
});

// Mock platform-resolver to avoid environment config loading issues
vi.mock('../platforms/platform-resolver.js', async () => {
  const actual = await vi.importActual('../platforms/platform-resolver.js');
  return {
    ...actual,
    getNodeEnvForEnvironment: vi.fn(() => 'test'),
    loadEnvironmentConfig: vi.fn(() => ({
      name: 'test',
      env: { NODE_ENV: 'test' }
    }))
  };
});

// Mock cli-paths to provide a test project root
vi.mock('../lib/cli-paths.js', () => ({
  getProjectRoot: vi.fn(() => '/test/project/root')
}));

describe('Start Command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Helper function to create service deployments for tests
  function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServicePlatformInfo[] {
    return services.map(service => ({
      name: service.name,
      platform: service.type as any,
      config: service.config || {}
    }));
  }

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful start', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' }
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
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'start',
            service: 'database',
            platform: 'container',
            success: true,
            startTime: expect.any(Date),
            status: expect.stringMatching(/running|ready/)
          }),
          expect.objectContaining({
            command: 'start',
            service: 'backend',
            platform: 'container',
            success: true
          })
        ]),
        summary: expect.objectContaining({
          total: 2,
          succeeded: 2,
          failed: 0
        })
      });
    });

    it('should handle dry run mode correctly', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process' }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'table',
        quiet: false,
        verbose: true,
        dryRun: true
      };

      const result = await start(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
    });

    it('should return error results for failed starts', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'invalid-image' } }
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
      expect(result.services).toHaveLength(1);
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);

      const options: StartOptions = {
        environment: 'production',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'aws',
        service: 'backend',
        status: 'not-implemented'
      });
    });

    it('should handle container deployment type', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'postgres:14' } }
      ]);

      const options: StartOptions = {
        environment: 'staging',
        output: 'summary',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'container',
        service: 'database',
        command: 'start'
      });
    });

    it('should handle process deployment type', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001, command: 'node server.js' } }
      ]);

      const options: StartOptions = {
        environment: 'local',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'process',
        service: 'backend',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            pid: expect.any(Number)
          })
        })
      });
    });

    it('should handle external deployment type', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432, name: 'prod_db' } }
      ]);

      const options: StartOptions = {
        environment: 'production',
        output: 'table',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'external',
        service: 'database',
        status: 'external',
        metadata: expect.objectContaining({
          host: 'db.example.com',
          port: 5432
        })
      });
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
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

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: true
      };

      const result = await start(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
    });

    it('should start specific service when named', async () => {

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(serviceDeployments, options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe('backend');
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

    it('should start MCP server with token refresh', async () => {
      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585, authMode: 'browser' } }
      ]);
      
      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        service: 'mcp'
      };

      const result = await start(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'start',
        environment: 'test',
        services: expect.arrayContaining([
          expect.objectContaining({
            service: 'mcp',
            platform: 'process',
            status: 'started',
            success: true
          })
        ])
      });

      // Verify fetch was called for token refresh
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/tokens/refresh'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: 'test-refresh-token' })
        })
      );
    });

    it('should handle missing MCP auth file', async () => {
      // Override the mock for this test
      vi.mock('fs', async () => {
        const actual = await vi.importActual<typeof import('fs')>('fs');
        return {
          ...actual,
          existsSync: vi.fn(() => false)
        };
      });

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585 } }
      ]);
      
      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false,
        service: 'mcp'
      };

      const result = await start(serviceDeployments, options);

      expect(result.success).toBe(false);
      expect(result.services[0]).toMatchObject({
        service: 'mcp',
        success: false,
        error: expect.stringContaining('not provisioned')
      });
    });

    it('should handle token refresh failure', async () => {
      // Mock failed token refresh
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized'
      });

      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585 } }
      ]);
      
      const options: StartOptions = {
        environment: 'production',
        output: 'json',
        quiet: true,
        verbose: false,
        dryRun: false,
        service: 'mcp'
      };

      const result = await start(serviceDeployments, options);

      expect(result.success).toBe(false);
      expect(result.services[0]).toMatchObject({
        service: 'mcp',
        success: false,
        error: expect.stringContaining('Failed to refresh access token')
      });
    });

    it('should support dry-run mode for MCP', async () => {
      const { start } = await import('../commands/start.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'mcp', type: 'process', config: { port: 8585 } }
      ]);
      
      const options: StartOptions = {
        environment: 'test',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: true,
        service: 'mcp'
      };

      const result = await start(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'start',
        environment: 'test',
        services: [
          {
            service: 'mcp',
            platform: 'process',
            status: 'dry-run',
            success: true,
            metadata: expect.objectContaining({
              dryRun: true
            })
          }
        ]
      });

      // Verify no actual fetch was made in dry-run mode
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});