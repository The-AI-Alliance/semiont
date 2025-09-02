/**
 * Command Results Type System Tests
 * 
 * Tests the core structured output interfaces and helper functions
 * that all migrated commands use for consistent result formatting.
 */

import { describe, it, expect } from 'vitest';
import { 
  createBaseResult,
  createErrorResult,
  type CommandResults 
} from '../core/command-results.js';
import { type StartResult } from '../core/commands/start.js';
import { type CheckResult } from '../core/commands/check.js';
import { type UpdateResult } from '../core/commands/update.js';
import { ServiceName } from '../core/service-discovery.js';
import { Platform } from '../core/platform-resolver.js';
import { PlatformResources } from '../platforms/platform-resources.js';

describe('Command Result Type System', () => {
  const startTime = Date.now();
  
  describe('createBaseResult()', () => {
    it('should create a valid base result structure', () => {
      const baseResult = createBaseResult('start', 'frontend', 'container', 'local', startTime);
      
      expect(baseResult).toMatchObject({
        command: 'start',
        service: 'frontend',
        platform: 'container',
        environment: 'local',
        success: true,
        timestamp: expect.any(Date),
        duration: expect.any(Number)
      });
      
      expect(baseResult.duration).toBeGreaterThanOrEqual(0);
      expect(baseResult.success).toBe(true);
      expect(baseResult.error).toBeUndefined();
    });

    it('should calculate duration correctly', () => {
      const testStartTime = Date.now() - 1000; // 1 second ago
      const result = createBaseResult('check', 'database', 'aws', 'production', testStartTime);
      
      expect(result.duration).toBeGreaterThanOrEqual(900);
      expect(result.duration).toBeLessThan(2000);
    });
  });

  describe('createErrorResult()', () => {
    it('should create an error result from base result', () => {
      const baseResult = createBaseResult('stop', 'backend', 'posix', 'staging', startTime);
      const error = new Error('Service not running');
      const errorResult = createErrorResult(baseResult, error);
      
      expect(errorResult).toMatchObject({
        ...baseResult,
        success: false,
        error: 'Service not running'
      });
    });

    it('should handle Error objects correctly', () => {
      const baseResult = createBaseResult('provision', 'database', 'aws', 'local', startTime);
      const error = new Error('AWS credentials not found');
      const errorResult = createErrorResult(baseResult, error);
      
      expect(errorResult.error).toBe('AWS credentials not found');
      expect(errorResult.success).toBe(false);
    });

    it('should handle string errors', () => {
      const baseResult = createBaseResult('publish', 'frontend', 'container', 'staging', startTime);
      const errorResult = createErrorResult(baseResult, 'Docker build failed');
      
      expect(errorResult.error).toBe('Docker build failed');
      expect(errorResult.success).toBe(false);
    });
  });

  describe('Command Result Interfaces', () => {
    it('should support StartResult structure', () => {
      const startResult: StartResult = {
        entity: 'frontend' as ServiceName,
        platform: 'container' as Platform,
        success: true,
        timestamp: new Date(),
        metadata: {
          containerName: 'semiont-frontend-local',
          image: 'semiont-frontend:latest'
        },
        extensions: {
          endpoint: 'http://localhost:3000',
          resources: {
            type: 'container',
            container: {
              id: 'abc123',
              name: 'semiont-frontend-local'
            }
          } as PlatformResources
        }
      };

      expect(startResult.timestamp).toBeInstanceOf(Date);
      expect(startResult.extensions?.endpoint).toBe('http://localhost:3000');
      expect((startResult.extensions?.resources as any)?.container?.id).toBe('abc123');
    });

    it('should support CheckResult structure', () => {
      const checkResult: CheckResult = {
        entity: 'database' as ServiceName,
        platform: 'aws' as Platform,
        success: true,
        timestamp: new Date(),
        metadata: {
          region: 'us-east-1',
          instanceClass: 'db.t3.micro'
        },
        extensions: {
          status: 'running',
          health: {
            healthy: true,
            details: {
              checks: [
                { name: 'connection', status: 'pass', message: 'Database accessible' },
                { name: 'disk_space', status: 'pass', message: '85% used' }
              ]
            }
          },
          resources: {
            type: 'aws',
            aws: {
              arn: 'arn:aws:rds:us-east-1:123456789012:db:prod-db',
              id: 'prod-db',
              name: 'production-database'
            }
          } as PlatformResources
        }
      };

      expect(checkResult.extensions?.health?.healthy).toBe(true);
      expect((checkResult.extensions?.health?.details as any)?.checks).toHaveLength(2);
      expect((checkResult.extensions?.health?.details as any)?.checks[0].status).toBe('pass');
    });

    it('should support UpdateResult structure', () => {
      const updateResult: UpdateResult = {
        entity: 'backend' as ServiceName,
        platform: 'aws' as Platform,
        success: true,
        timestamp: new Date(),
        metadata: {
          deploymentId: 'deploy-123456',
          forceNewDeployment: true,
          changesApplied: [
            { type: 'infrastructure', description: 'ECS service updated' },
            { type: 'config', description: 'Environment variables updated' }
          ]
        },
        extensions: {
          previousVersion: 'v1.2.3',
          newVersion: 'v1.2.4',
          strategy: 'rolling',
          resources: {
            type: 'aws',
            aws: {
              arn: 'arn:aws:ecs:us-east-1:123456789012:service/staging/backend',
              id: 'semiont-staging-backend',
              name: 'semiont-staging-backend'
            }
          } as PlatformResources
        }
      };

      expect(updateResult.extensions?.strategy).toBe('rolling');
      expect((updateResult.metadata as any)?.changesApplied).toHaveLength(2);
      expect((updateResult.metadata as any)?.changesApplied[0].type).toBe('infrastructure');
    });
  });

  describe('CommandResults Aggregation', () => {
    it('should create valid CommandResults structure', () => {
      const services = [
        {
          ...createBaseResult('start', 'frontend', 'container', 'local', startTime),
          startTime: new Date(),
          resourceId: { container: { id: 'abc123', name: 'frontend' } },
          status: 'running',
          metadata: {}
        },
        {
          ...createBaseResult('start', 'backend', 'container', 'local', startTime),
          startTime: new Date(),
          resourceId: { container: { id: 'def456', name: 'backend' } },
          status: 'running',
          metadata: {}
        }
      ];

      const commandResults: CommandResults = {
        command: 'start',
        environment: 'local',
        timestamp: new Date(),
        duration: 1500,
        services,
        summary: {
          total: 2,
          succeeded: 2,
          failed: 0,
          warnings: 0
        },
        executionContext: {
          user: 'testuser',
          workingDirectory: '/app',
          dryRun: false
        }
      };

      expect(commandResults.summary.total).toBe(2);
      expect(commandResults.summary.succeeded).toBe(2);
      expect(commandResults.services).toHaveLength(2);
      expect(commandResults.executionContext.dryRun).toBe(false);
    });

    it('should handle mixed success/failure results', () => {
      const services = [
        {
          ...createBaseResult('restart', 'frontend', 'posix', 'local', startTime),
          restartTime: new Date(),
          resourceId: { process: { pid: 12345, port: 3000 } },
          status: 'running',
          metadata: {}
        },
        {
          ...createErrorResult(
            createBaseResult('restart', 'backend', 'posix', 'local', startTime), 
            'Port already in use'
          ),
          restartTime: new Date(),
          resourceId: { process: { pid: 0, port: 3001 } },
          status: 'failed',
          metadata: {}
        }
      ];

      const commandResults: CommandResults = {
        command: 'restart',
        environment: 'local',
        timestamp: new Date(),
        duration: 2100,
        services,
        summary: {
          total: 2,
          succeeded: 1,
          failed: 1,
          warnings: 0
        },
        executionContext: {
          user: 'testuser',
          workingDirectory: '/app',
          dryRun: false
        }
      };

      expect(commandResults.summary.succeeded).toBe(1);
      expect(commandResults.summary.failed).toBe(1);
      expect(services[0]!.success).toBe(true);
      expect(services[1]!.success).toBe(false);
      expect(services[1]!.error).toBe('Port already in use');
    });
  });
});