/**
 * Provision Command Tests
 * 
 * Tests the provision command's structured output functionality for
 * infrastructure provisioning across different deployment types.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProvisionOptions } from '../commands/provision.js';

// Mock child_process for CDK operations
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn((event, callback) => {
      if (event === 'exit') {
        setTimeout(() => callback(0), 10);
      }
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() }
  }))
}));

// Mock container runtime
vi.mock('../lib/container-runtime.js', () => ({
  runContainer: vi.fn(),
  stopContainer: vi.fn()
}));

describe('Provision Command', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-provision-test-'));
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
    it('should return CommandResults structure for successful provisioning', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          database: {
            deployment: { type: 'aws' },
            instanceClass: 'db.t3.micro',
            engine: 'postgres',
            engineVersion: '15'
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'staging',
        service: 'database',
        stack: 'infra',
        destroy: false,
        force: false,
        requireApproval: true,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await provision(options);

      expect(result).toMatchObject({
        command: 'provision',
        environment: 'staging',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'provision',
            service: 'database',
            deploymentType: 'aws',
            success: true,
            provisionTime: expect.any(Date),
            resourceId: expect.objectContaining({
              aws: expect.objectContaining({
                arn: expect.stringContaining('arn:aws:rds'),
                id: expect.stringContaining('semiont-staging-db')
              })
            }),
            status: expect.any(String),
            infrastructureChanges: expect.any(Array),
            metadata: expect.objectContaining({
              stack: 'infra'
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
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            image: 'nginx:alpine'
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'test',
        service: 'frontend',
        stack: 'app',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: true,
        dryRun: true,
        output: 'table'
      };

      const result = await provision(options);

      expect(result.services[0]).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should handle destroy mode', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          backend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'staging',
        service: 'backend',
        stack: 'app',
        destroy: true,
        force: true,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await provision(options);

      expect(result.services[0]).toMatchObject({
        service: 'backend',
        status: expect.stringMatching(/(destroyed|not-implemented)/),
        metadata: expect.objectContaining({
          destroy: true,
          force: true
        })
      });
    });

    it('should handle seed mode for databases', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15',
            password: 'localpass',
            name: 'testdb'
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'local',
        service: 'database',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: true,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await provision(options);

      expect(result.services[0]).toMatchObject({
        service: 'database',
        metadata: expect.objectContaining({
          seed: true
        })
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS provisioning with CDK', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' },
            image: 'frontend:latest'
          },
          backend: {
            deployment: { type: 'aws' },
            image: 'backend:latest'
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'production',
        service: 'all',
        stack: 'infra',
        destroy: false,
        force: false,
        requireApproval: true,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await provision(options);

      expect(result.services).toHaveLength(2);
      
      result.services.forEach(service => {
        expect(service).toMatchObject({
          deploymentType: 'aws',
          resourceId: expect.objectContaining({
            aws: expect.objectContaining({
              arn: expect.stringContaining('arn:aws:'),
              id: expect.stringContaining('semiont-production')
            })
          }),
          infrastructureChanges: expect.any(Array)
        });
      });
    });

    it('should handle container provisioning', async () => {
      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('local', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15',
            password: 'localpass'
          },
          frontend: {
            deployment: { type: 'container' },
            image: 'nginx:alpine',
            port: 3000
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'local',
        service: 'all',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: true,
        dryRun: false,
        output: 'table'
      };

      const result = await provision(options);

      expect(result.services).toHaveLength(2);
      
      result.services.forEach(service => {
        expect(service).toMatchObject({
          deploymentType: 'container',
          resourceId: expect.objectContaining({
            container: expect.objectContaining({
              name: expect.stringContaining('semiont')
            })
          })
        });
      });
    });

    it('should handle process provisioning', async () => {
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

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'local',
        service: 'backend',
        stack: 'app',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await provision(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'process',
        status: expect.stringMatching(/(provisioned|ready|not-applicable)/),
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            path: expect.any(String)
          })
        })
      });
    });

    it('should handle external services appropriately', async () => {
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

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'remote',
        service: 'database',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await provision(options);

      expect(result.services[0]).toMatchObject({
        deploymentType: 'external',
        status: 'external',
        resourceId: expect.objectContaining({
          external: expect.objectContaining({
            endpoint: 'db.example.com:5432'
          })
        }),
        metadata: expect.objectContaining({
          reason: expect.stringContaining('External')
        })
      });
    });
  });

  describe('Stack Selection', () => {
    it('should provision infrastructure stack only', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          database: {
            deployment: { type: 'aws' }
          },
          frontend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'staging',
        service: 'all',
        stack: 'infra',
        destroy: false,
        force: false,
        requireApproval: true,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await provision(options);

      result.services.forEach(service => {
        expect(service.metadata).toMatchObject({
          stack: 'infra'
        });
      });
    });

    it('should provision application stack only', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' }
          },
          backend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'staging',
        service: 'all',
        stack: 'app',
        destroy: false,
        force: false,
        requireApproval: true,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await provision(options);

      result.services.forEach(service => {
        expect(service.metadata).toMatchObject({
          stack: 'app'
        });
      });
    });

    it('should provision all stacks when stack is "all"', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          database: {
            deployment: { type: 'aws' }
          },
          frontend: {
            deployment: { type: 'aws' }
          },
          backend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'production',
        service: 'all',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: true,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await provision(options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
    });
  });

  describe('Infrastructure Changes Tracking', () => {
    it('should track infrastructure changes for AWS resources', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          database: {
            deployment: { type: 'aws' },
            instanceClass: 'db.t3.micro'
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'staging',
        service: 'database',
        stack: 'infra',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await provision(options);

      expect(result.services[0].infrastructureChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: expect.stringMatching(/(create|update|delete)/),
            resource: expect.any(String),
            description: expect.any(String)
          })
        ])
      );
    });

    it('should show no changes for external services', async () => {
      await createTestEnvironment('remote', {
        deployment: { default: 'external' },
        services: {
          database: {
            deployment: { type: 'external' },
            host: 'db.example.com'
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'remote',
        service: 'database',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await provision(options);

      expect(result.services[0].infrastructureChanges).toEqual([]);
    });
  });

  describe('Error Handling', () => {
    it('should handle CDK deployment failures', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;
      mockSpawn.mockReturnValue({
        pid: 12345,
        on: vi.fn((event, callback) => {
          if (event === 'exit') {
            setTimeout(() => callback(1), 10); // Exit code 1 indicates failure
          }
        }),
        stdout: { on: vi.fn() },
        stderr: { 
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('CDK deployment failed');
          })
        }
      });

      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'production',
        service: 'frontend',
        stack: 'app',
        destroy: false,
        force: false,
        requireApproval: true,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await provision(options);

      expect(result.services[0]).toMatchObject({
        success: expect.any(Boolean),
        status: expect.any(String)
      });
    });

    it('should handle container provisioning failures', async () => {
      const { runContainer } = await import('../lib/container-runtime.js');
      (runContainer as any).mockResolvedValue(false);

      await createTestEnvironment('local', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15'
          }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'local',
        service: 'database',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await provision(options);

      expect(result.services[0]).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed')
      });

      expect(result.summary.failed).toBe(1);
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { provision } = await import('../commands/provision.js');

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: ProvisionOptions = {
          environment: 'test',
          service: 'backend',
          stack: 'all',
          destroy: false,
          force: false,
          requireApproval: false,
          reset: false,
          seed: false,
          verbose: false,
          dryRun: false,
          output: format
        };

        const result = await provision(options);
        
        expect(result).toMatchObject({
          command: 'provision',
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
    it('should provision all services when service is "all"', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'test',
        service: 'all',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await provision(options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      const serviceNames = result.services.map(s => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'database', 'frontend']);
    });

    it('should provision specific service when named', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: { deployment: { type: 'container' } },
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { provision } = await import('../commands/provision.js');
      
      const options: ProvisionOptions = {
        environment: 'test',
        service: 'database',
        stack: 'all',
        destroy: false,
        force: false,
        requireApproval: false,
        reset: false,
        seed: false,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await provision(options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0].service).toBe('database');
      expect(result.summary.total).toBe(1);
    });
  });
});