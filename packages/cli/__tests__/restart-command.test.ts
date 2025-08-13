/**
 * Restart Command Tests
 * 
 * Tests the restart command's structured output functionality with
 * graceful stop and start operations across deployment types.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RestartOptions } from '../commands/restart.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

// Mock the container runtime
vi.mock('../lib/container-runtime.js', () => ({
  runContainer: vi.fn().mockResolvedValue(true),
  stopContainer: vi.fn().mockResolvedValue(true)
}));

// Mock child_process for process restarts
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

describe('Restart Command', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-restart-test-'));
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
    it('should return CommandResults structure for successful restart', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' },
            image: 'backend:latest',
            port: 3001
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container', config: { image: 'backend:latest', port: 3001 } }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'restart',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'restart',
            service: 'backend',
            deploymentType: 'container',
            success: true,
            stopTime: expect.any(Date),
            startTime: expect.any(Date),
            gracefulRestart: true,
            resourceId: expect.objectContaining({
              container: expect.objectContaining({
                name: 'semiont-backend-test'
              })
            }),
            status: 'restarted',
            metadata: expect.objectContaining({
              gracePeriod: 3
            })
          })
        ]),
        summary: {
          total: 1,
          succeeded: 1,
          failed: 0,
          warnings: 0
        }
      });
    });

    it('should handle dry run mode correctly', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'process' },
        services: {
          frontend: {
            deployment: { type: 'process' },
            port: 3000
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000 } }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'table',
        force: false,
        gracePeriod: 5,
        verbose: true,
        dryRun: true
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true,
          gracePeriod: 5
        })
      });
    });

    it('should handle force mode for stubborn services', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      // Stop fails, but force allows continuation
      (stopContainer as any).mockResolvedValue(false);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'postgres:15' } }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'yaml',
        force: true,
        gracePeriod: 2,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      // With force=true, should continue despite stop failure
      expect(result.services[0]!).toMatchObject({
        status: 'force-continued',
        success: true,
        metadata: expect.objectContaining({
          forced: true,
          gracePeriod: 2
        })
      });
    });

    it('should respect grace period between stop and start', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            image: 'nginx:alpine'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { image: 'nginx:alpine' } }
      ]);

      const gracePeriod = 2; // seconds
      const options: RestartOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        gracePeriod,
        verbose: false,
        dryRun: false
      };

      const startTime = Date.now();
      const result = await restart(serviceDeployments, options);
      const endTime = Date.now();

      // Should have waited at least gracePeriod seconds
      // Allow some margin for test execution
      expect(endTime - startTime).toBeGreaterThanOrEqual(gracePeriod * 900); // 90% of expected time
      
      expect(result.services[0]!.metadata.gracePeriod).toBe(gracePeriod);
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);

      const options: RestartOptions = {
        environment: 'production',
        output: 'json',
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'aws',
        status: 'not-implemented',
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            arn: expect.stringContaining('arn:aws:ecs'),
            id: 'semiont-production-backend'
          })
        })
      });
    });

    it('should handle container deployment type', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15',
            name: 'stagingdb'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'postgres:15', name: 'stagingdb' } }
      ]);

      const options: RestartOptions = {
        environment: 'staging',
        output: 'summary',
        force: false,
        gracePeriod: 3,
        verbose: true,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'container',
        status: 'restarted',
        resourceId: expect.objectContaining({
          container: expect.objectContaining({
            name: 'semiont-postgres-staging'
          })
        })
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

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001, command: 'node server.js' } }
      ]);

      const options: RestartOptions = {
        environment: 'local',
        output: 'table',
        force: false,
        gracePeriod: 1,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'process',
        status: 'restarted',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            port: 3001,
            path: 'apps/backend'
          })
        }),
        metadata: expect.objectContaining({
          command: 'node server.js',
          port: 3001
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
            port: 5432
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432 } }
      ]);

      const options: RestartOptions = {
        environment: 'production',
        output: 'yaml',
        force: false,
        gracePeriod: 3,
        verbose: true,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'external',
        status: 'external',
        downtime: 0, // External services don't have downtime
        resourceId: expect.objectContaining({
          external: expect.objectContaining({
            endpoint: 'db.example.com:5432'
          })
        }),
        metadata: expect.objectContaining({
          reason: 'External services cannot be restarted remotely'
        })
      });
    });
  });

  describe('Service Selection', () => {
    it('should restart all services when service is "all"', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        gracePeriod: 1,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      const serviceNames = result.services.map(s => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'database', 'frontend']);
    });

    it('should restart specific service when named', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'table',
        force: false,
        gracePeriod: 2,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe('backend');
      expect(result.summary.total).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle failed stop operations', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'summary',
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed')
      });

      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });

    it('should handle failed start operations', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(false); // Start fails

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'json',
        force: false,
        gracePeriod: 2,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed')
      });

      expect(result.summary.failed).toBe(1);
    });

    it('should continue with force mode even on failures', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any)
        .mockResolvedValueOnce(false)  // First stop fails
        .mockResolvedValueOnce(true)   // Second stop succeeds
        .mockResolvedValueOnce(true);  // Third stop succeeds
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: RestartOptions = {
        environment: 'test',
        output: 'table',
        force: true,
        gracePeriod: 1,
        verbose: false,
        dryRun: false
      };

      const result = await restart(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      // First one continues despite stop failure (force mode)
      expect(result.services[0]!.status).toBe('force-continued');
      expect(result.services[0]!.success).toBe(true);
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: RestartOptions = {
          environment: 'test',
          output: format,
          force: false,
          gracePeriod: 1,
          verbose: false,
          dryRun: false
        };

        const result = await restart(serviceDeployments, options);
        
        expect(result).toMatchObject({
          command: 'restart',
          environment: 'test',
          services: expect.any(Array),
          summary: expect.objectContaining({
            total: expect.any(Number),
            succeeded: expect.any(Number),
            failed: expect.any(Number)
          })
        });
      }
    });
  });
});