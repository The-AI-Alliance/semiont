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

// Mock the container runtime
vi.mock('../lib/container-runtime.js', () => ({
  runContainer: vi.fn(),
  stopContainer: vi.fn()
}));

// Mock child_process for process restarts
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
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
    fs.writeFileSync(
      path.join(configDir, `${envName}.json`),
      JSON.stringify(config, null, 2)
    );
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
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'backend',
        output: 'json',
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

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
            restartTime: expect.any(Date),
            endpoint: expect.stringContaining('http://localhost:3001'),
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
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'frontend',
        output: 'table',
        force: false,
        gracePeriod: 5,
        verbose: true,
        dryRun: true
      };

      const result = await restart(options);

      expect(result.services[0]).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true,
          gracePeriod: 5
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should handle force mode for stubborn services', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      // Stop fails initially, but force makes it continue
      (stopContainer as any).mockResolvedValue(false);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15',
            password: 'testpass'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'database',
        output: 'yaml',
        force: true,
        gracePeriod: 2,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

      // With force=true, should continue despite stop failure
      expect(result.services[0]).toMatchObject({
        status: 'restarted',
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
            image: 'frontend:latest',
            port: 3000
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const gracePeriod = 2; // 2 seconds
      const startTime = Date.now();
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'frontend',
        output: 'summary',
        force: false,
        gracePeriod,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);
      const endTime = Date.now();

      // Should have waited at least gracePeriod seconds
      // Allow some margin for test execution
      expect(endTime - startTime).toBeGreaterThanOrEqual(gracePeriod * 900); // 90% of grace period
      
      expect(result.services[0].metadata.gracePeriod).toBe(gracePeriod);
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          backend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'production',
        service: 'backend',
        output: 'summary',
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

      expect(result.services[0]).toMatchObject({
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
            password: 'stagingpass',
            name: 'stagingdb',
            user: 'staginguser'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'staging',
        service: 'database',
        output: 'json',
        force: false,
        gracePeriod: 3,
        verbose: true,
        dryRun: false
      };

      const result = await restart(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'container',
        status: 'restarted',
        endpoint: 'postgresql://localhost:5432/stagingdb',
        resourceId: expect.objectContaining({
          container: expect.objectContaining({
            name: 'semiont-postgres-staging'
          })
        })
      });

      // Verify stop and start were called with correct parameters
      expect(stopContainer).toHaveBeenCalledWith('semiont-postgres-staging', {
        force: false,
        verbose: true,
        timeout: 10
      });

      expect(runContainer).toHaveBeenCalledWith('postgres:15', 'semiont-postgres-staging', {
        ports: { '5432': '5432' },
        environment: {
          POSTGRES_PASSWORD: 'stagingpass',
          POSTGRES_DB: 'stagingdb',
          POSTGRES_USER: 'staginguser'
        },
        detached: true,
        verbose: true
      });
    });

    it('should handle process deployment type', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001,
            command: 'npm run dev'
          }
        }
      });

      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;
      
      // Mock for finding process to kill
      mockSpawn.mockReturnValueOnce({
        stdout: { 
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('12345\n');
          })
        },
        on: vi.fn((event, cb) => {
          if (event === 'exit') cb(0);
        })
      });

      // Mock for starting new process
      mockSpawn.mockReturnValueOnce({
        pid: 67890,
        unref: vi.fn(),
        on: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'local',
        service: 'backend',
        output: 'table',
        force: false,
        gracePeriod: 1,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'process',
        status: 'restarted',
        endpoint: 'http://localhost:3001',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            pid: expect.any(Number),
            port: 3001,
            path: 'apps/backend'
          })
        }),
        metadata: expect.objectContaining({
          command: 'npm run dev',
          gracePeriod: 1
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
            port: 5432,
            name: 'proddb'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'remote',
        service: 'database',
        output: 'yaml',
        force: false,
        gracePeriod: 3,
        verbose: true,
        dryRun: false
      };

      const result = await restart(options);

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
          reason: 'External services must be restarted manually'
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
          database: { 
            deployment: { type: 'container' },
            image: 'postgres:15'
          },
          frontend: { 
            deployment: { type: 'container' },
            image: 'nginx:alpine',
            port: 3000
          },
          backend: { 
            deployment: { type: 'container' },
            image: 'node:18',
            port: 3001
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'all',
        output: 'json',
        force: false,
        gracePeriod: 1,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

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
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'frontend',
        output: 'table',
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].service).toBe('frontend');
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
          backend: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'backend',
        output: 'summary',
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

      expect(result.services[0]).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed to stop')
      });

      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });

    it('should handle failed start operations', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(false);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { 
            deployment: { type: 'container' },
            image: 'frontend:latest'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'frontend',
        output: 'table',
        force: false,
        gracePeriod: 1,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

      expect(result.services[0]).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed to start')
      });

      expect(result.summary.failed).toBe(1);
    });

    it('should continue with force mode even on failures', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);
      (runContainer as any).mockResolvedValue(false);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } }
        }
      });

      const { restart } = await import('../commands/restart.js');
      
      const options: RestartOptions = {
        environment: 'test',
        service: 'database',
        output: 'yaml',
        force: true,
        gracePeriod: 1,
        verbose: false,
        dryRun: false
      };

      const result = await restart(options);

      // With force=true, should mark as completed despite failures
      expect(result.services[0].metadata.forced).toBe(true);
      expect(result.services[0].status).toMatch(/failed|force/);
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
          backend: { 
            deployment: { type: 'container' },
            image: 'backend:latest'
          }
        }
      });

      const { restart } = await import('../commands/restart.js');

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: RestartOptions = {
          environment: 'test',
          service: 'backend',
          output: format,
          force: false,
          gracePeriod: 1,
          verbose: false,
          dryRun: false
        };

        const result = await restart(options);
        
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