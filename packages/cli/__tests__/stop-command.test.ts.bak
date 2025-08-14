/**
 * Stop Command Tests
 * 
 * Tests the stop command's structured output functionality across
 * different deployment types (aws, container, process, external).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { StopOptions } from '../commands/stop.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

// Mock the container runtime to avoid actual Docker calls
vi.mock('../lib/container-runtime.js', () => ({
  stopContainer: vi.fn().mockResolvedValue(true)
}));

// Mock child_process to avoid spawning real processes
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn((event, callback) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
    }),
    stdout: { 
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from('12345\n'));
        }
      })
    },
    stderr: { on: vi.fn() }
  }))
}));

describe('Stop Command', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-stop-test-'));
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
    it('should return CommandResults structure for successful stop', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

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

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'stop',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'stop',
            service: 'backend',
            deploymentType: 'container',
            success: true,
            stopTime: expect.any(Date),
            status: 'stopped'
          }),
          expect.objectContaining({
            command: 'stop',
            service: 'database',
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

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000 } }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'table',
        force: false,
        verbose: true,
        dryRun: true
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
    });

    it('should handle force stop mode', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:14'
          }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: true,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        command: 'stop',
        service: 'database',
        forcedTermination: true
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);

      const options: StopOptions = {
        environment: 'production',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'aws',
        service: 'backend',
        status: 'not-implemented'
      });
    });

    it('should handle container deployment type', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:14'
          }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'postgres:14' } }
      ]);

      const options: StopOptions = {
        environment: 'staging',
        output: 'summary',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'container',
        service: 'database',
        command: 'stop'
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

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: StopOptions = {
        environment: 'local',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'process',
        service: 'backend',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            port: 3001
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

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432, name: 'prod_db' } }
      ]);

      const options: StopOptions = {
        environment: 'production',
        output: 'table',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'external',
        service: 'database',
        status: 'external',
        metadata: expect.objectContaining({
          host: 'db.example.com',
          port: 5432,
          reason: 'External services cannot be stopped remotely'
        })
      });
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' },
            image: 'backend:latest'
          }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const formats = ['summary', 'json', 'yaml', 'table'] as const;
      
      for (const format of formats) {
        const options: StopOptions = {
          environment: 'test',
          output: format,
          force: false,
          verbose: false,
          dryRun: true
        };

        const result = await stop(serviceDeployments, options);
        
        expect(result).toBeDefined();
        expect(result.command).toBe('stop');
      }
    });
  });

  describe('Service Selection', () => {
    it('should stop all services in reverse order when service is "all"', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      // Note: Services are passed in normal order, stop.ts will reverse them
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: true
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      // Services should be stopped in reverse order: frontend, backend, database
      expect(result.services[0]!.service).toBe('frontend');
      expect(result.services[1]!.service).toBe('backend');
      expect(result.services[2]!.service).toBe('database');
    });

    it('should stop specific service when named', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe('backend');
    });
  });

  describe('Error Handling', () => {
    it('should handle failed stop operations', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'summary',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        success: false,
        status: 'failed'
      });

      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });

    it('should continue on error when force is true', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any)
        .mockResolvedValueOnce(true)  // First service succeeds
        .mockResolvedValueOnce(false) // Second service fails
        .mockResolvedValueOnce(true); // Third service succeeds

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: StopOptions = {
        environment: 'test',
        output: 'table',
        force: true,
        verbose: false,
        dryRun: false
      };

      const result = await stop(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      expect(result.summary.succeeded).toBe(2);
      expect(result.summary.failed).toBe(1);
    });
  });
});