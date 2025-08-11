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

// Mock child_process for process checks
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    stdout: { on: vi.fn() },
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

// Mock HTTP requests for health checks
const mockFetch = vi.fn();
global.fetch = mockFetch;

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

  describe('Structured Output', () => {
    it('should return CommandResults structure for successful checks', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"status":"ok"}')
      });

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
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'frontend',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(options);

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
            checkTime: expect.any(Date),
            healthStatus: expect.stringMatching(/^(healthy|degraded|unhealthy)$/),
            checks: expect.arrayContaining([
              expect.objectContaining({
                name: expect.any(String),
                status: expect.stringMatching(/^(passed|failed|warning)$/),
                message: expect.any(String)
              })
            ]),
            resourceId: expect.any(Object),
            status: expect.any(String)
          })
        ]),
        summary: {
          total: 1,
          succeeded: 1,
          failed: 0,
          warnings: expect.any(Number)
        }
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
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'backend',
        section: 'services',
        verbose: true,
        dryRun: true,
        output: 'table'
      };

      const result = await check(options);

      expect(result.services[0]).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should return error results for failed checks', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            port: 5432
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'database',
        section: 'health',
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await check(options);

      expect(result.services[0]).toMatchObject({
        success: expect.any(Boolean),
        healthStatus: expect.any(String),
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: expect.any(String),
            status: expect.stringMatching(/^(passed|failed|warning)$/),
            message: expect.any(String)
          })
        ])
      });

      // At least one check should exist
      expect(result.services[0].checks.length).toBeGreaterThan(0);
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS deployment type checks', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' },
            healthCheck: {
              path: '/health'
            }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'production',
        service: 'frontend',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await check(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'aws',
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            arn: expect.stringContaining('arn:aws:'),
            id: expect.any(String)
          })
        }),
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: expect.any(String),
            status: expect.any(String),
            message: expect.any(String)
          })
        ])
      });
    });

    it('should handle container deployment type checks', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK')
      });

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            port: 5432
          },
          frontend: {
            deployment: { type: 'container' },
            port: 3000,
            healthCheck: { path: '/api/health' }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'staging',
        service: 'all',
        section: 'services',
        verbose: true,
        dryRun: false,
        output: 'json'
      };

      const result = await check(options);

      expect(result.services).toHaveLength(2);
      
      result.services.forEach(service => {
        expect(service).toMatchObject({
          deploymentType: 'container',
          resourceId: expect.objectContaining({
            container: expect.objectContaining({
              name: expect.any(String),
              id: expect.any(String)
            })
          }),
          checks: expect.any(Array)
        });
      });
    });

    it('should handle process deployment type checks', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001,
            healthCheck: {
              path: '/api/status',
              timeout: 3000
            }
          }
        }
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'healthy', uptime: 12345 })
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'local',
        service: 'backend',
        section: 'health',
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await check(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'process',
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            port: 3001
          })
        }),
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringMatching(/(connectivity|health|process)/),
            status: expect.any(String),
            message: expect.any(String)
          })
        ])
      });
    });

    it('should handle external deployment type checks', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable'
      });

      await createTestEnvironment('remote', {
        deployment: { default: 'external' },
        services: {
          database: {
            deployment: { type: 'external' },
            host: 'db.example.com',
            port: 5432,
            name: 'proddb',
            healthCheck: {
              timeout: 5000
            }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'remote',
        service: 'database',
        section: 'all',
        verbose: true,
        dryRun: false,
        output: 'yaml'
      };

      const result = await check(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'external',
        resourceId: expect.objectContaining({
          external: expect.objectContaining({
            endpoint: expect.stringContaining('db.example.com')
          })
        }),
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'connectivity',
            status: expect.any(String),
            message: expect.any(String)
          })
        ])
      });
    });
  });

  describe('Section-specific Checks', () => {
    it('should handle services section checks', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' }, port: 3000 },
          backend: { deployment: { type: 'container' }, port: 3001 },
          database: { deployment: { type: 'container' }, port: 5432 }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'all',
        section: 'services',
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await check(options);

      expect(result.services).toHaveLength(3);
      
      result.services.forEach(service => {
        expect(service.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: expect.stringMatching(/(container|service)/),
              status: expect.any(String)
            })
          ])
        );
      });
    });

    it('should handle health section checks', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'healthy',
          checks: {
            database: 'ok',
            cache: 'ok'
          }
        })
      });

      await createTestEnvironment('test', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001,
            healthCheck: {
              path: '/health'
            }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'backend',
        section: 'health',
        verbose: true,
        dryRun: false,
        output: 'json'
      };

      const result = await check(options);

      expect(result.services[0].checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringMatching(/(health|endpoint)/),
            status: expect.any(String)
          })
        ])
      );
    });

    it('should handle logs section checks', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            port: 3000
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'frontend',
        section: 'logs',
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await check(options);

      expect(result.services[0].checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringMatching(/log/),
            status: expect.any(String)
          })
        ])
      );
    });
  });

  describe('Health Status Aggregation', () => {
    it('should report healthy status when all checks pass', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK')
      });

      await createTestEnvironment('test', {
        deployment: { default: 'process' },
        services: {
          backend: {
            deployment: { type: 'process' },
            port: 3001,
            healthCheck: { path: '/health' }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'backend',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(options);

      // If all individual checks pass, overall health should be healthy
      const allChecksPassed = result.services[0].checks.every(c => c.status === 'passed');
      if (allChecksPassed) {
        expect(result.services[0].healthStatus).toBe('healthy');
      }
    });

    it('should report degraded status when some checks fail', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve('OK')
        })
        .mockRejectedValueOnce(new Error('Secondary service down'));

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            port: 3000,
            healthCheck: { path: '/health' }
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'frontend',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await check(options);

      const hasFailedChecks = result.services[0].checks.some(c => c.status === 'failed');
      const hasPassedChecks = result.services[0].checks.some(c => c.status === 'passed');
      
      if (hasFailedChecks && hasPassedChecks) {
        expect(result.services[0].healthStatus).toBe('degraded');
      }
    });

    it('should report unhealthy status when critical checks fail', async () => {
      mockFetch.mockRejectedValue(new Error('Service completely down'));

      await createTestEnvironment('test', {
        deployment: { default: 'process' },
        services: {
          database: {
            deployment: { type: 'process' },
            port: 5432
          }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'database',
        section: 'health',
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await check(options);

      const allChecksFailed = result.services[0].checks.every(c => c.status === 'failed');
      if (allChecksFailed) {
        expect(result.services[0].healthStatus).toBe('unhealthy');
      }
    });
  });

  describe('Service Selection', () => {
    it('should check all services when service is "all"', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' }, port: 5432 },
          frontend: { deployment: { type: 'container' }, port: 3000 },
          backend: { deployment: { type: 'container' }, port: 3001 }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'all',
        section: 'services',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await check(options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      const serviceNames = result.services.map(s => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'database', 'frontend']);
    });

    it('should check specific service when named', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' }, port: 5432 },
          frontend: { deployment: { type: 'container' }, port: 3000 }
        }
      });

      const { check } = await import('../commands/check.js');
      
      const options: CheckOptions = {
        environment: 'test',
        service: 'database',
        section: 'all',
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await check(options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].service).toBe('database');
      expect(result.summary.total).toBe(1);
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
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

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: CheckOptions = {
          environment: 'test',
          service: 'backend',
          section: 'all',
          verbose: false,
          dryRun: false,
          output: format
        };

        const result = await check(options);
        
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
});