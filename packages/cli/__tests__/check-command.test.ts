/**
 * Check Command Tests
 * 
 * Tests the check command's structured output functionality across
 * different deployment types and health check scenarios.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CheckOptions } from '../commands/check.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

// Mock child_process for process checks
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    stdout: { 
      on: vi.fn((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from('12345\n'));
        }
      })
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event, callback) => {
      if (event === 'exit') {
        // Simulate successful health check
        setTimeout(() => callback(0), 10);
      }
    })
  })),
  exec: vi.fn((cmd, callback) => {
    // Mock successful command execution
    callback(null, 'mock output', '');
  })
}));

// Mock container runtime
vi.mock('../lib/container-runtime.js', () => ({
  listContainers: vi.fn().mockResolvedValue(['semiont-frontend-test', 'semiont-backend-test'])
}));

// Mock HTTP module for health checks
vi.mock('http', () => ({
  get: vi.fn((url, callback) => {
    const res = {
      statusCode: 200,
      on: vi.fn()
    };
    callback(res);
    return { on: vi.fn() };
  }),
  default: {
    get: vi.fn((url, callback) => {
      const res = {
        statusCode: 200,
        on: vi.fn()
      };
      callback(res);
      return { on: vi.fn() };
    })
  }
}));

describe('Check Command', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-check-test-'));
    configDir = path.join(testDir, 'config', 'environments');
    fs.mkdirSync(configDir, { recursive: true });
    process.chdir(testDir);
    vi.clearAllMocks();
  });
  
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function createTestEnvironment(envName: string, config: any) {
    fs.writeFileSync(
      path.join(configDir, `${envName}.json`),
      JSON.stringify(config, null, 2)
    );
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
    it('should return CommandResults structure for successful checks', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            port: 3000,
            healthCheck: {
              path: '/health',
              timeout: 5000
            }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'check',
        environment: 'test',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'check',
            service: 'frontend',
            deploymentType: 'container',
            success: true,
            lastCheck: expect.any(Date),
            healthStatus: expect.any(String),
            checks: expect.any(Array),
            resourceId: expect.objectContaining({
              container: expect.objectContaining({
                name: 'semiont-frontend-test'
              })
            })
          })
        ]),
        summary: {
          total: 1,
          succeeded: expect.any(Number),
          failed: expect.any(Number),
          warnings: expect.any(Number)
        },
        executionContext: expect.objectContaining({
          user: expect.any(String),
          workingDirectory: expect.any(String),
          dryRun: false
        })
      });
    });

    it('should handle dry run mode correctly', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'services',
        verbose: true,
        dryRun: true,
        output: 'table'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
    });

    it('should filter by section when specified', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'services',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      // Should have checked services
      expect(result.services.length).toBeGreaterThan(0);
      result.services.forEach((service: any) => {
        expect(service.checks).toBeDefined();
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          backend: {
            deployment: { type: 'aws' },
            arn: 'arn:aws:ecs:us-east-1:123456789012:service/prod/backend'
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);

      const options: CheckOptions = {
        environment: 'production',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'aws',
        status: expect.any(String),
        resourceId: expect.objectContaining({
          aws: expect.any(Object)
        })
      });
    });

    it('should handle container deployment type', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-postgres-staging']);

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15'
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { image: 'postgres:15' } }
      ]);

      const options: CheckOptions = {
        environment: 'staging',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'container',
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
          frontend: {
            deployment: { type: 'process' },
            port: 3000,
            command: 'npm run dev'
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000, command: 'npm run dev' } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: true,
        dryRun: false,
        output: 'table'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'process',
        resourceId: expect.objectContaining({
          process: expect.any(Object)
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

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432 } }
      ]);

      const options: CheckOptions = {
        environment: 'production',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'external',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: expect.any(String),
            status: expect.any(String)
          })
        ])
      });
    });

    it('should handle mock deployment type', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'mock' },
        services: {
          backend: {
            deployment: { type: 'mock' }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'mock' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'mock',
        healthStatus: 'healthy',
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'mock-service',
            status: 'pass'
          })
        ])
      });
    });
  });

  describe('Health Check Features', () => {
    it('should check container health status', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-backend-test']);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' },
            port: 3001
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container', config: { port: 3001 } }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'health',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any;
      expect(service.checks).toBeDefined();
      expect(service.checks.some((c: any) => c.name === 'container-running')).toBe(true);
    });

    it('should check process port availability', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001 } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any; // CheckResult type
      
      expect(service).toBeDefined();
      expect(service.checks).toBeDefined();
      const processCheck = service.checks.find((c: any) => c.name === 'process-running');
      expect(processCheck).toBeDefined();
    });

    it('should check filesystem accessibility', async () => {
      const dataPath = path.join(testDir, 'data');
      fs.mkdirSync(dataPath, { recursive: true });

      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          filesystem: {
            deployment: { type: 'process' },
            path: dataPath
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'filesystem', type: 'process', config: { path: dataPath } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any;
      expect(service.checks).toBeDefined();
      const fsCheck = service.checks.find((c: any) => c.name === 'filesystem-access');
      expect(fsCheck).toBeDefined();
      expect(fsCheck.status).toBe('pass');
    });

    it('should check external service connectivity', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'external' },
        services: {
          backend: {
            deployment: { type: 'external' },
            host: 'api.example.com',
            port: 443
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'external', config: { host: 'api.example.com', port: 443 } }
      ]);

      const options: CheckOptions = {
        environment: 'production',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      const service = result.services[0]! as any;
      expect(service.checks).toBeDefined();
      expect(service.healthStatus).toBeDefined();
    });
  });

  describe('Service Selection', () => {
    it('should check all services when not specified', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue([
        'semiont-postgres-test',
        'semiont-backend-test',
        'semiont-frontend-test'
      ]);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container' },
        { name: 'backend', type: 'container' },
        { name: 'frontend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      const serviceNames = result.services.map((s: any) => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'database', 'frontend']);
    });

    it('should check specific service when provided', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-backend-test']);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await check(serviceDeployments, options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe('backend');
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue(['semiont-backend-test']);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: CheckOptions = {
          environment: 'test',
          section: 'all',
          verbose: false,
          dryRun: false,
          output: format
        };

        const result = await check(serviceDeployments, options);
        
        expect(result).toMatchObject({
          command: 'check',
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

  describe('Error Handling', () => {
    it('should handle container not running', async () => {
      const { listContainers } = await import('../lib/container-runtime.js');
      (listContainers as any).mockResolvedValue([]); // No containers running

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);

      const options: CheckOptions = {
        environment: 'test',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect((result.services[0] as any).healthStatus).toBe('unhealthy');
      expect((result.services[0] as any).checks).toContainEqual(
        expect.objectContaining({
          name: 'container-running',
          status: 'fail'
        })
      );
    });

    it('should handle filesystem not accessible', async () => {
      const nonExistentPath = path.join(testDir, 'non-existent');

      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          filesystem: {
            deployment: { type: 'process' },
            path: nonExistentPath
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const serviceDeployments = createServiceDeployments([
        { name: 'filesystem', type: 'process', config: { path: nonExistentPath } }
      ]);

      const options: CheckOptions = {
        environment: 'local',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(serviceDeployments, options);

      expect((result.services[0] as any).healthStatus).toBe('unhealthy');
      expect((result.services[0] as any).checks).toContainEqual(
        expect.objectContaining({
          name: 'filesystem-access',
          status: 'fail'
        })
      );
    });
  });
});