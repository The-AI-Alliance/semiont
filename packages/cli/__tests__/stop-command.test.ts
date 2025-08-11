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

// Mock the container runtime to avoid actual Docker calls
vi.mock('../lib/container-runtime.js', () => ({
  runContainer: vi.fn(),
  stopContainer: vi.fn()
}));

// Mock child_process to avoid killing real processes
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
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
    fs.writeFileSync(
      path.join(configDir, `${envName}.json`),
      JSON.stringify(config, null, 2)
    );
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
            image: 'postgres:15-alpine'
          }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'test',
        service: 'database',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(result).toMatchObject({
        command: 'stop',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'stop',
            service: 'database',
            deploymentType: 'container',
            success: true,
            stopTime: expect.any(Date),
            resourceId: expect.objectContaining({
              container: expect.objectContaining({
                name: 'semiont-postgres-test'
              })
            }),
            status: 'stopped'
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

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'test',
        service: 'frontend',
        output: 'table',
        force: false,
        verbose: true,
        dryRun: true
      };

      const result = await stop(options);

      expect(result.services[0]).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should handle force mode for stubborn services', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      // First call fails, force should make it succeed
      (stopContainer as any)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

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
      
      const options: StopOptions = {
        environment: 'test',
        service: 'backend',
        output: 'yaml',
        force: true,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(stopContainer).toHaveBeenCalledWith('semiont-backend-test', {
        force: true,
        verbose: false,
        timeout: 10
      });

      expect(result.services[0].metadata).toMatchObject({
        containerName: 'semiont-backend-test',
        forced: true
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'production',
        service: 'frontend',
        output: 'summary',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'aws',
        status: 'not-implemented',
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            arn: expect.stringContaining('arn:aws:ecs'),
            id: 'semiont-production-frontend'
          })
        })
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
            image: 'postgres:15'
          },
          frontend: {
            deployment: { type: 'container' },
            image: 'nginx:alpine'
          }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'staging',
        service: 'all',
        output: 'json',
        force: false,
        verbose: true,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services).toHaveLength(2);
      
      result.services.forEach(service => {
        expect(service).toMatchObject({
          deploymentType: 'container',
          status: 'stopped',
          resourceId: expect.objectContaining({
            container: expect.objectContaining({
              name: expect.stringContaining('semiont')
            })
          })
        });
      });
    });

    it('should handle process deployment type', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001
          }
        }
      });

      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        stdout: { 
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('12345\n');
          })
        },
        on: vi.fn((event, cb) => {
          if (event === 'exit') cb(0);
        })
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'local',
        service: 'backend',
        output: 'table',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'process',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            port: 3001
          })
        })
      });
    });

    it('should handle external deployment type', async () => {
      await createTestEnvironment('remote', {
        deployment: { default: 'external' },
        services: {
          database: {
            deployment: { type: 'external' },
            host: 'db.example.com',
            port: 5432
          }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'remote',
        service: 'database',
        output: 'yaml',
        force: false,
        verbose: true,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'external',
        status: 'external',
        resourceId: expect.objectContaining({
          external: expect.objectContaining({
            endpoint: 'db.example.com:5432'
          })
        }),
        metadata: expect.objectContaining({
          host: 'db.example.com',
          port: 5432,
          reason: 'External services must be stopped manually'
        })
      });
    });
  });

  describe('Service Selection', () => {
    it('should stop all services when service is "all"', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'test',
        service: 'all',
        output: 'json',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      const serviceNames = result.services.map(s => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'database', 'frontend']);
    });

    it('should stop specific service when named', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'test',
        service: 'database',
        output: 'table',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].service).toBe('database');
      expect(result.summary.total).toBe(1);
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
      
      const options: StopOptions = {
        environment: 'test',
        service: 'frontend',
        output: 'summary',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services[0]).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed to stop')
      });

      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });

    it('should continue on error when stopping multiple services', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any)
        .mockResolvedValueOnce(true)  // First service succeeds
        .mockResolvedValueOnce(false) // Second service fails
        .mockResolvedValueOnce(true); // Third service succeeds

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');
      
      const options: StopOptions = {
        environment: 'test',
        service: 'all',
        output: 'table',
        force: false,
        verbose: false,
        dryRun: false
      };

      const result = await stop(options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      expect(result.summary.succeeded).toBe(2);
      expect(result.summary.failed).toBe(1);
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { stop } = await import('../commands/stop.js');

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: StopOptions = {
          environment: 'test',
          service: 'backend',
          output: format,
          force: false,
          verbose: false,
          dryRun: false
        };

        const result = await stop(options);
        
        expect(result).toMatchObject({
          command: 'stop',
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