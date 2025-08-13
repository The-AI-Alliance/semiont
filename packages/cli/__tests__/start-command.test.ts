/**
 * Start Command Tests
 * 
 * Tests the start command's structured output functionality across
 * different deployment types (aws, container, process, external).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { StartOptions } from '../commands/start.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

// Mock the container runtime to avoid actual Docker calls
vi.mock('../lib/container-runtime.js', () => ({
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

describe('Start Command', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-start-test-'));
    configDir = path.join(testDir, 'config', 'environments');
    fs.mkdirSync(configDir, { recursive: true });
    process.chdir(testDir);
  });
  
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createTestEnvironment(envName: string, config: any) {
    const envFile = path.join(configDir, `${envName}.json`);
    fs.writeFileSync(envFile, JSON.stringify(config, null, 2));
  }

  // Helper function to create service deployments for tests
  function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServiceDeploymentInfo[] {
    return services.map(service => ({
      name: service.name,
      deploymentType: service.type as any,
      config: service.config || {}
    }));
  }

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful start', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:14',
            port: 5432
          },
          backend: {
            deployment: { type: 'container' },
            image: 'semiont-backend',
            port: 3001
          }
        }
      });

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
            deploymentType: 'container',
            success: true,
            startTime: expect.any(Date),
            status: expect.stringMatching(/running|ready/)
          }),
          expect.objectContaining({
            command: 'start',
            service: 'backend',
            deploymentType: 'container',
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
      await createTestEnvironment('test', {
        deployment: { default: 'process' },
        services: {
          frontend: {
            deployment: { type: 'process' },
            port: 3000,
            command: 'npm run dev'
          }
        }
      });

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
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'invalid-image'
          }
        }
      });

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
        deploymentType: 'aws',
        service: 'backend',
        status: 'not-implemented'
      });
    });

    it('should handle container deployment type', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:14'
          }
        }
      });

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
        deploymentType: 'container',
        service: 'database',
        command: 'start'
      });
    });

    it('should handle process deployment type', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001,
            command: 'node server.js'
          }
        }
      });

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
        deploymentType: 'process',
        service: 'backend',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            pid: expect.any(Number)
          })
        })
      });
    });

    it('should handle external deployment type', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'external' },
        services: {
          database: {
            deployment: { type: 'external' },
            host: 'db.example.com',
            port: 5432,
            name: 'prod_db'
          }
        }
      });

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
        deploymentType: 'external',
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
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' },
            image: 'backend:latest'
          }
        }
      });

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
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

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
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

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
});