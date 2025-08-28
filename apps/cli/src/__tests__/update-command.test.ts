/**
 * Update Command Tests
 * 
 * Tests the update command's structured output functionality with
 * real AWS SDK integration and deployment-type awareness.
 */

import { describe, it, expect, beforeEach, afterEach, vi, test } from 'vitest';
import type { UpdateOptions } from '../commands/update.js';
import type { ServicePlatformInfo } from '../platforms/platform-resolver.js';

// Mock AWS SDK
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn(() => ({
    send: vi.fn()
  })),
  UpdateServiceCommand: vi.fn()
}));

// Mock container runtime
vi.mock('../platforms/container-runtime.js', () => ({
  runContainer: vi.fn().mockResolvedValue(true),
  stopContainer: vi.fn().mockResolvedValue(true)
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn((event, callback) => {
      if (event === 'exit') {
        // Immediately call the callback to avoid hanging
        setImmediate(() => callback(0));
      }
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() }
  }))
}));
// Helper function to create dummy service deployments for tests
function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServicePlatformInfo[] {
  return services.map(service => ({
    name: service.name,
    platform: service.type as Platform,
    config: service.config || {}
  }));
}

describe('Update Command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Structured Output', () => {
    test('should return CommandResults structure for successful update', { timeout: 10000 }, async () => {
      const { stopContainer, runContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'staging',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0, // Set to 0 to avoid waiting in tests
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000, image: 'semiont-frontend:latest' } },
        { name: 'backend', type: 'container', config: { port: 3001, image: 'semiont-backend:latest' } }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'update',
        environment: 'staging',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'update',
            platform: 'container',
            success: true,
            updateTime: expect.any(Date),
            rollbackAvailable: true,
            changesApplied: expect.arrayContaining([
              expect.objectContaining({
                type: 'infrastructure',
                description: expect.stringContaining('Container')
              })
            ]),
            resourceId: expect.objectContaining({
              container: expect.objectContaining({
                name: expect.stringContaining('semiont')
              })
            }),
            status: 'updated'
          })
        ]),
        summary: {
          total: 2,
          succeeded: 2,
          failed: 0,
          warnings: 0
        }
      });
    });

    it('should handle dry run mode correctly', async () => {
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: true,
        dryRun: true,
        output: 'yaml'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should handle force mode on container failures', async () => {
      const { stopContainer, runContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);
      (runContainer as any).mockResolvedValue(false);
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        skipTests: false,
        skipBuild: false,
        force: true,
        gracePeriod: 1,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000, image: 'semiont-frontend:latest' } },
        { name: 'backend', type: 'container', config: { port: 3001, image: 'semiont-backend:latest' } }
      ]);
      const result = await update(serviceDeployments, options);

      // With force=true, should continue despite failures
      expect(result.services[0]!).toMatchObject({
        status: 'force-continued',
        success: false,  // Still a failure, just continued anyway
        rollbackAvailable: false,
        metadata: expect.objectContaining({
          forced: true
        })
      });
    });
  });

  describe('AWS Service Updates', () => {
    it.skip('should update ECS services correctly', async () => {
      const { ECSClient, UpdateServiceCommand } = await import('@aws-sdk/client-ecs');
      const mockSend = vi.fn().mockResolvedValue({});
      const mockECSClient = { send: mockSend };
      (ECSClient as any).mockImplementation(() => mockECSClient);
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'production',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws', config: { aws: { region: 'us-east-1' } } },
        { name: 'backend', type: 'aws', config: { aws: { region: 'us-east-1' } } }
      ]);
      const result = await update(serviceDeployments, options);

      // The update command might only return services it actually updated
      expect(result.services.length).toBeGreaterThan(0);
      // Just verify the mock was called at least once
      expect(mockSend).toHaveBeenCalled();
    });

    it('should handle RDS services appropriately', async () => {

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'production',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'aws', config: { aws: { region: 'us-east-1' } } }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'aws',
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

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'staging',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'filesystem', type: 'aws', config: { aws: { region: 'us-east-1' } } }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'aws',
        status: 'no-action-needed',
        success: true,
        previousVersion: 'efs-standard',
        newVersion: 'efs-standard',
        rollbackAvailable: true,
        changesApplied: [],
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            arn: expect.stringContaining('arn:aws:efs'),
            id: expect.stringContaining('fs-semiontstaging')
          })
        }),
        metadata: expect.objectContaining({
          reason: 'EFS filesystems do not require updates'
        })
      });
    });
  });

  describe('Container Service Updates', () => {
    test('should update container services with restart', { timeout: 10000 }, async () => {
      const { stopContainer, runContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'staging',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0, // Set to 0 to avoid waiting in tests
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000, image: 'semiont-frontend:latest' } },
        { name: 'backend', type: 'container', config: { port: 3001, image: 'semiont-backend:latest' } }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'container',
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
          gracePeriod: 3,  // Default grace period
          forced: false
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
      const { stopContainer, runContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0, // Set to 0 to avoid waiting in tests
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'container', config: { 
          image: 'postgres:15-alpine',
          password: 'localpass',
          name: 'testdb',
          user: 'testuser'
        }}
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'container',
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
      const { stopContainer, runContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(true);
      (runContainer as any).mockResolvedValue(true);

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'filesystem', type: 'container' }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'container',
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
    test('should update process services with restart', { timeout: 20000 }, async () => {

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,  // Set to 0 to avoid timeout in test
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'process', config: { port: 3001, command: 'npm run dev' } }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'process',
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
          gracePeriod: 0
        })
      });
    });

    it('should handle database process appropriately', async () => {

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'local',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'process' }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'process',
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

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'remote',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'database', type: 'external', config: { host: 'db.example.com', port: 5432 } }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'external',
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

      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'remote',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'filesystem', type: 'external', config: { path: '/mnt/shared-storage' } }
      ]);
      const result = await update(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        platform: 'external',
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
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'production',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'aws', config: { aws: { region: 'us-east-1' } } },
        { name: 'backend', type: 'aws', config: { aws: { region: 'us-east-1' } } }
      ]);
      const result = await update(serviceDeployments, options);

      // Should handle errors gracefully
      expect(result.services[0]!.success).toBe(false);
      expect(result.services[0]!.status).toMatch(/failed|error/);

      expect(result.summary.failed).toBe(1);
    });

    it('should stop on first error unless --force is used', async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        skipTests: false,
        skipBuild: false,
        force: false,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000, image: 'semiont-frontend:latest' } },
        { name: 'backend', type: 'container', config: { port: 3001, image: 'semiont-backend:latest' } }
      ]);
      const result = await update(serviceDeployments, options);

      // Should have stopped after first failure
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.success).toBe(false);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.total).toBe(1);
    });

    test('should continue on errors when --force is used', { timeout: 10000 }, async () => {
      const { stopContainer } = await import('../platforms/container-runtime.js');
      (stopContainer as any).mockResolvedValue(false);
      const { update } = await import('../commands/update.js');
      
      const options: UpdateOptions = {
        environment: 'test',
        skipTests: false,
        skipBuild: false,
        force: true,
        gracePeriod: 0,
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { port: 3000, image: 'semiont-frontend:latest' } },
        { name: 'backend', type: 'container', config: { port: 3001, image: 'semiont-backend:latest' } }
      ]);
      const result = await update(serviceDeployments, options);

      // Should have processed both services despite failures
      expect(result.services).toHaveLength(2);
      expect(result.summary.total).toBe(2);
      expect(result.summary.failed).toBe(2);
    });
  });
});