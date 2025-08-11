/**
 * Update Command Tests
 * 
 * Tests the update command's structured output functionality with
 * real AWS SDK integration and deployment-type awareness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { UpdateOptions } from '../commands/update.js';

// Mock AWS SDK
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn(() => ({
    send: vi.fn()
  })),
  UpdateServiceCommand: vi.fn()
}));

// Mock container runtime
vi.mock('../lib/container-runtime.js', () => ({
  runContainer: vi.fn(),
  stopContainer: vi.fn()
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() }
  }))
}));

describe('Update Command', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-update-test-'));
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
    it('should return CommandResults structure for successful update', async () => {
      const { ECSClient } = await import('@aws-sdk/client-ecs');
      const mockECSClient = {
        send: vi.fn().mockResolvedValue({})
      };
      (ECSClient as any).mockImplementation(() => mockECSClient);

      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' },
            image: 'frontend:latest'
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'staging',
        service: 'frontend',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await update(options);

      expect(result).toMatchObject({
        command: 'update',
        environment: 'staging',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'update',
            service: 'frontend',
            deploymentType: 'aws',
            success: true,
            updateTime: expect.any(Date),
            previousVersion: 'latest',
            newVersion: 'latest-updated',
            rollbackAvailable: true,
            changesApplied: expect.arrayContaining([
              expect.objectContaining({
                type: 'infrastructure',
                description: expect.stringContaining('ECS deployment initiated')
              })
            ]),
            resourceId: expect.objectContaining({
              aws: expect.objectContaining({
                arn: expect.stringContaining('arn:aws:ecs'),
                id: 'semiont-staging-frontend',
                name: 'semiont-staging-frontend'
              })
            }),
            status: 'updated'
          })
        ]),
        summary: {
          total: 1,
          succeeded: 1,
          failed: 0,
          warnings: 0
        }
      });

      // Verify ECS client was called correctly
      expect(mockECSClient.send).toHaveBeenCalledTimes(1);
    });

    it('should handle dry run mode correctly', async () => {
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

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        service: 'backend',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: true,
        dryRun: true,
        output: 'yaml'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should handle force mode on container failures', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);
      (runContainer as any).mockResolvedValue(false);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15'
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        service: 'database',
        skipTests: false,
        skipBuild: false,
        force: true,
        gracePeriod: 1,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await update(options);

      // With force=true, should continue despite failures
      expect(result.services[0]).toMatchObject({
        status: 'force-continued',
        success: true,
        rollbackAvailable: false,
        metadata: expect.objectContaining({
          forced: true
        })
      });
    });
  });

  describe('AWS Service Updates', () => {
    it('should update ECS services correctly', async () => {
      const { ECSClient, UpdateServiceCommand } = await import('@aws-sdk/client-ecs');
      const mockSend = vi.fn().mockResolvedValue({});
      const mockECSClient = { send: mockSend };
      (ECSClient as any).mockImplementation(() => mockECSClient);

      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: { deployment: { type: 'aws' } },
          backend: { deployment: { type: 'aws' } }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'production',
        service: 'all',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await update(options);

      expect(result.services).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
      
      // Verify UpdateServiceCommand was called correctly
      const updateCommands = (UpdateServiceCommand as any).mock.calls;
      expect(updateCommands).toHaveLength(2);
      
      expect(updateCommands[0][0]).toMatchObject({
        cluster: 'semiont-production',
        service: 'semiont-production-frontend',
        forceNewDeployment: true
      });
      
      expect(updateCommands[1][0]).toMatchObject({
        cluster: 'semiont-production',
        service: 'semiont-production-backend',
        forceNewDeployment: true
      });
    });

    it('should handle RDS services appropriately', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          database: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'production',
        service: 'database',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'database',
        deploymentType: 'aws',
        status: 'not-applicable',
        success: true,
        previousVersion: 'postgres-15',
        newVersion: 'postgres-15',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            arn: expect.stringContaining('arn:aws:rds'),
            id: expect.stringContaining('semiont-production-db')
          })
        }),
        metadata: expect.objectContaining({
          reason: 'RDS instances require manual updates'
        })
      });
    });

    it('should handle EFS services appropriately', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          filesystem: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'staging',
        service: 'filesystem',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'filesystem',
        deploymentType: 'aws',
        status: 'no-action-needed',
        success: true,
        previousVersion: 'efs-standard',
        newVersion: 'efs-standard',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            arn: expect.stringContaining('arn:aws:efs'),
            id: expect.stringContaining('fs-semionstaging')
          })
        }),
        metadata: expect.objectContaining({
          reason: 'EFS filesystems do not require updates'
        })
      });
    });
  });

  describe('Container Service Updates', () => {
    it('should update container services with restart', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            image: 'semiont-frontend:latest',
            port: 3000
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'staging',
        service: 'frontend',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 2,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'frontend',
        deploymentType: 'container',
        status: 'updated',
        success: true,
        rollbackAvailable: true,
        changesApplied: expect.arrayContaining([
          expect.objectContaining({
            type: 'infrastructure',
            description: expect.stringContaining('Container semiont-frontend-staging updated')
          })
        ]),
        resourceId: expect.objectContaining({
          container: expect.objectContaining({
            id: 'semiont-frontend-staging',
            name: 'semiont-frontend-staging'
          })
        }),
        metadata: expect.objectContaining({
          containerName: 'semiont-frontend-staging',
          image: 'semiont-frontend:latest',
          gracePeriod: 2
        })
      });

      expect(stopContainer).toHaveBeenCalledWith('semiont-frontend-staging', {
        force: false,
        verbose: false,
        timeout: 10
      });

      expect(runContainer).toHaveBeenCalledWith('semiont-frontend:latest', 'semiont-frontend-staging', {
        ports: { '3000': '3000' },
        detached: true,
        verbose: false
      });
    });

    it('should handle database container updates', async () => {
      const { stopContainer, runContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      await createTestEnvironment('local', {
        deployment: { default: 'container' },
        services: {
          database: {
            deployment: { type: 'container' },
            image: 'postgres:15-alpine',
            password: 'localpass',
            name: 'testdb',
            user: 'testuser'
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        service: 'database',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'database',
        deploymentType: 'container',
        status: 'updated',
        success: true
      });

      expect(runContainer).toHaveBeenCalledWith('postgres:15-alpine', 'semiont-postgres-local', {
        ports: { '5432': '5432' },
        environment: {
          POSTGRES_PASSWORD: 'localpass',
          POSTGRES_DB: 'testdb',
          POSTGRES_USER: 'testuser'
        },
        detached: true,
        verbose: false
      });
    });

    it('should handle filesystem volumes appropriately', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'container' },
        services: {
          filesystem: {
            deployment: { type: 'container' }
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        service: 'filesystem',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'filesystem',
        deploymentType: 'container',
        status: 'updated',
        success: true,
        previousVersion: 'volume',
        newVersion: 'volume',
        metadata: expect.objectContaining({
          containerName: 'semiont-filesystem-local',
          image: 'volume'
        })
      });
    });
  });

  describe('Process Service Updates', () => {
    it('should update process services with restart', async () => {
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

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        service: 'backend',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 2,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'backend',
        deploymentType: 'process',
        status: 'updated',
        success: true,
        previousVersion: 'development',
        newVersion: 'development-updated',
        rollbackAvailable: true,
        changesApplied: expect.arrayContaining([
          expect.objectContaining({
            type: 'code',
            description: 'Process updated on port 3001'
          })
        ]),
        resourceId: expect.objectContaining({
          process: expect.objectContaining({
            pid: 12345,
            port: 3001,
            path: 'apps/backend'
          })
        }),
        metadata: expect.objectContaining({
          command: 'npm run dev',
          port: 3001,
          gracePeriod: 2
        })
      });
    });

    it('should handle database process appropriately', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          database: {
            deployment: { type: 'process' }
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        service: 'database',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'database',
        deploymentType: 'process',
        status: 'not-applicable',
        success: true,
        previousVersion: 'postgres-local',
        newVersion: 'postgres-local',
        metadata: expect.objectContaining({
          reason: 'PostgreSQL service updates require manual intervention'
        })
      });
    });
  });

  describe('External Service Updates', () => {
    it('should handle external database services', async () => {
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

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'remote',
        service: 'database',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'database',
        deploymentType: 'external',
        status: 'external',
        success: true,
        previousVersion: 'external',
        newVersion: 'external',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: expect.objectContaining({
          external: expect.objectContaining({
            endpoint: 'db.example.com:5432'
          })
        }),
        metadata: expect.objectContaining({
          host: 'db.example.com',
          port: 5432,
          reason: 'External database updates must be managed by the database provider'
        })
      });
    });

    it('should handle external filesystem services', async () => {
      await createTestEnvironment('remote', {
        deployment: { default: 'external' },
        services: {
          filesystem: {
            deployment: { type: 'external' },
            path: '/mnt/shared-storage'
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'remote',
        service: 'filesystem',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        service: 'filesystem',
        deploymentType: 'external',
        status: 'external',
        success: true,
        resourceId: expect.objectContaining({
          external: expect.objectContaining({
            path: '/mnt/shared-storage'
          })
        }),
        metadata: expect.objectContaining({
          path: '/mnt/shared-storage',
          reason: 'External storage updates must be managed by the storage provider'
        })
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle AWS SDK errors gracefully', async () => {
      const { ECSClient } = await import('@aws-sdk/client-ecs');
      const mockECSClient = {
        send: vi.fn().mockRejectedValue(new Error('AWS credentials not configured'))
      };
      (ECSClient as any).mockImplementation(() => mockECSClient);

      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'production',
        service: 'frontend',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const result = await update(options);

      expect(result.services[0]).toMatchObject({
        success: false,
        status: 'failed',
        error: 'AWS credentials not configured',
        rollbackAvailable: false,
        metadata: expect.objectContaining({
          error: 'AWS credentials not configured'
        })
      });

      expect(result.summary.failed).toBe(1);
    });

    it('should stop on first error unless --force is used', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        service: 'all',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const result = await update(options);

      // Should have stopped after first failure
      expect(result.services).toHaveLength(1);
      expect(result.services[0].success).toBe(false);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.total).toBe(1);
    });

    it('should continue on errors when --force is used', async () => {
      const { stopContainer } = await import('../lib/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);

      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        service: 'all',
        skipTests: false,
        skipBuild: false,
        force: true,
        gracePeriod: 3,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const result = await update(options);

      // Should have processed both services despite failures
      expect(result.services).toHaveLength(2);
      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBe(2);
    });
  });
});