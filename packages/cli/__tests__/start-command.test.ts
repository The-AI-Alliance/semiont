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

// Mock the container runtime to avoid actual Docker calls
vi.mock('../lib/container-runtime.js', () => ({
  runContainer: vi.fn(),
  stopContainer: vi.fn()
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
    fs.writeFileSync(
      path.join(configDir, `${envName}.json`),
      JSON.stringify(config, null, 2)
    );
  }

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful start', async () => {
      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15-alpine',
            password: 'testpass',
            name: 'testdb',
            user: 'testuser'
          }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'test',
        service: 'database',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(options);

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
            endpoint: expect.stringContaining('postgresql://'),
            resourceId: expect.objectContaining({
              container: expect.objectContaining({
                name: 'semiont-postgres-test'
              })
            }),
            status: 'running'
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
            port: 3000,
            command: 'npm run dev'
          }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'test',
        service: 'frontend',
        output: 'table',
        quiet: false,
        verbose: true,
        dryRun: true
      };

      const result = await start(options);

      expect(result.services[0]).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should return error results for failed starts', async () => {
      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(false);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' },
            image: 'nonexistent:latest',
            port: 3001
          }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'test',
        service: 'backend',
        output: 'yaml',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(options);

      expect(result.services[0]).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed to start')
      });

      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' },
            image: 'frontend:latest'
          }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'production',
        service: 'frontend',
        output: 'summary',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(options);

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
      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15',
            password: 'stagingpass'
          },
          filesystem: {
            deployment: { type: 'container' }
          }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'staging',
        service: 'all',
        output: 'json',
        quiet: false,
        verbose: true,
        dryRun: false
      };

      const result = await start(options);

      expect(result.services).toHaveLength(2);
      
      // Database service
      const dbService = result.services.find(s => s.service === 'database');
      expect(dbService).toMatchObject({
        deploymentType: 'container',
        status: 'running',
        endpoint: expect.stringContaining('postgresql://')
      });

      // Filesystem service
      const fsService = result.services.find(s => s.service === 'filesystem');
      expect(fsService).toMatchObject({
        deploymentType: 'container',
        status: 'ready'
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
          },
          frontend: {
            deployment: { type: 'process' },
            port: 3000,
            command: 'npm start'
          }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'local',
        service: 'all',
        output: 'table',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(options);

      expect(result.services).toHaveLength(2);
      
      result.services.forEach(service => {
        expect(service).toMatchObject({
          deploymentType: 'process',
          resourceId: expect.objectContaining({
            process: expect.objectContaining({
              pid: expect.any(Number),
              port: expect.any(Number)
            })
          })
        });
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

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'remote',
        service: 'database',
        output: 'yaml',
        quiet: false,
        verbose: true,
        dryRun: false
      };

      const result = await start(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'external',
        status: 'external',
        endpoint: 'postgresql://db.example.com:5432/proddb',
        resourceId: expect.objectContaining({
          external: expect.objectContaining({
            endpoint: 'db.example.com:5432'
          })
        }),
        metadata: expect.objectContaining({
          host: 'db.example.com',
          port: 5432,
          connectivityCheck: 'not-implemented'
        })
      });
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15'
          }
        }
      });

      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(true);

      const { start } = await import('../commands/start.js');

      // Test each output format
      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: StartOptions = {
          environment: 'test',
          service: 'database',
          output: format,
          quiet: false,
          verbose: false,
          dryRun: false
        };

        const result = await start(options);
        
        expect(result).toMatchObject({
          command: 'start',
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

  describe('Service Selection', () => {
    it('should start all services when service is "all"', async () => {
      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' }, image: 'postgres:15' },
          frontend: { deployment: { type: 'container' }, image: 'nginx:alpine' },
          backend: { deployment: { type: 'container' }, image: 'node:18' }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'test',
        service: 'all',
        output: 'json',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      const serviceNames = result.services.map(s => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'database', 'frontend']);
    });

    it('should start specific service when named', async () => {
      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' }, image: 'postgres:15' },
          frontend: { deployment: { type: 'container' }, image: 'nginx:alpine' }
        }
      });

      const { start } = await import('../commands/start.js');
      
      const options: StartOptions = {
        environment: 'test',
        service: 'database',
        output: 'table',
        quiet: false,
        verbose: false,
        dryRun: false
      };

      const result = await start(options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].service).toBe('database');
      expect(result.summary.total).toBe(1);
    });
  });
});