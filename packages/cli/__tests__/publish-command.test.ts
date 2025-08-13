/**
 * Publish Command Tests
 * 
 * Tests the publish command's structured output functionality for
 * building and pushing container images to registries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PublishOptions } from '../commands/publish.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

// Mock AWS ECR
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn(() => ({
    send: vi.fn()
  })),
  GetAuthorizationTokenCommand: vi.fn(),
  BatchGetImageCommand: vi.fn(),
  DescribeRepositoriesCommand: vi.fn()
}));

// Mock child_process for Docker operations
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


// Helper function to create dummy service deployments for tests
function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServiceDeploymentInfo[] {
  return services.map(service => ({
    name: service.name,
    deploymentType: service.type as any,
    deployment: { type: service.type },
    config: service.config || {}
  }));
}

describe('Publish Command', () => {
  let testDir: string;
  let configDir: string;
  let originalCwd: string;
  
  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semiont-publish-test-'));
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
    it('should return CommandResults structure for successful publish', async () => {
      const { ECRClient } = await import('@aws-sdk/client-ecr');
      const mockECRClient = {
        send: vi.fn().mockResolvedValue({
          authorizationData: [{
            authorizationToken: Buffer.from('user:pass').toString('base64'),
            proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com'
          }]
        })
      };
      (ECRClient as any).mockImplementation(() => mockECRClient);

      await createTestEnvironment('staging', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' },
            image: 'frontend:latest'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',        output: 'json',
        tag: 'v1.2.3',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'publish',
        environment: 'staging',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'publish',            deploymentType: 'aws',
            success: true,
            publishTime: expect.any(Date),
            imageTag: 'v1.2.3',
            repository: expect.stringContaining('.dkr.ecr.'),
            resourceId: expect.objectContaining({
              aws: expect.objectContaining({
                repository: expect.stringContaining('semiont-staging-frontend')
              })
            }),
            status: expect.any(String),
            metadata: expect.objectContaining({
              tag: 'v1.2.3',
              skipBuild: false
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
          backend: {
            deployment: { type: 'container' },
            image: 'backend:latest'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'test',        output: 'table',
        tag: 'latest',
        skipBuild: false,
        verbose: true,
        dryRun: true
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        success: true,
        metadata: expect.objectContaining({
          dryRun: true
        })
      });

      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should handle skip build mode', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            image: 'frontend:latest',
            registry: 'localhost:5000'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',        output: 'yaml',
        tag: 'v2.0.0',
        skipBuild: true,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        imageTag: 'v2.0.0',
        metadata: expect.objectContaining({
          skipBuild: true,
          tag: 'v2.0.0'
        })
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS ECR publishing', async () => {
      const { ECRClient } = await import('@aws-sdk/client-ecr');
      const mockECRClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ // GetAuthorizationToken
            authorizationData: [{
              authorizationToken: Buffer.from('AWS:secret').toString('base64'),
              proxyEndpoint: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com'
            }]
          })
          .mockResolvedValueOnce({ // DescribeRepositories
            repositories: [{
              repositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/semiont-production-backend'
            }]
          })
      };
      (ECRClient as any).mockImplementation(() => mockECRClient);

      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          backend: {
            deployment: { type: 'aws' },
            image: 'backend:latest'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'production',        output: 'summary',
        tag: 'v1.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'aws',
        imageTag: 'v1.0.0',
        repository: expect.stringContaining('.dkr.ecr.'),
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            repository: expect.stringContaining('semiont-production-backend')
          })
        })
      });

      // Verify ECR client was called
      expect(mockECRClient.send).toHaveBeenCalled();
    });

    it('should handle container registry publishing', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            image: 'frontend:latest',
            registry: 'registry.example.com'
          },
          backend: {
            deployment: { type: 'container' },
            image: 'backend:latest',
            registry: 'registry.example.com'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',        output: 'json',
        tag: 'staging-latest',
        skipBuild: false,
        verbose: true,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services).toHaveLength(2);
      
      result.services.forEach(service => {
        expect(service).toMatchObject({
          deploymentType: 'container',
          imageTag: 'staging-latest',
          repository: expect.stringContaining('registry.example.com'),
          metadata: expect.objectContaining({
            registry: 'registry.example.com',
            tag: 'staging-latest'
          })
        });
      });
    });

    it('should handle local Docker registry', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' },
            image: 'backend:latest',
            registry: 'localhost:5000'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'local',        output: 'table',
        tag: 'dev',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'container',
        imageTag: 'dev',
        repository: 'localhost:5000',
        metadata: expect.objectContaining({
          registry: 'localhost:5000'
        })
      });
    });

    it('should skip process deployment type', async () => {
      await createTestEnvironment('local', {
        deployment: { default: 'process' },
        services: {
          frontend: {
            deployment: { type: 'process' },
            port: 3000
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'local',        output: 'yaml',
        tag: 'latest',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'process',
        status: expect.stringMatching(/(not-applicable|skipped)/),
        success: true,
        metadata: expect.objectContaining({
          reason: expect.stringContaining('Process deployments')
        })
      });
    });

    it('should skip external deployment type', async () => {
      await createTestEnvironment('remote', {
        deployment: { default: 'external' },
        services: {
          database: {
            deployment: { type: 'external' },
            host: 'db.example.com'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'remote',        output: 'summary',
        tag: 'latest',
        skipBuild: false,
        verbose: true,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'external',
        status: 'external',
        success: true,
        metadata: expect.objectContaining({
          reason: expect.stringContaining('External services')
        })
      });
    });
  });

  describe('Build and Push Operations', () => {
    it('should build and push images when skipBuild is false', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;
      
      let dockerBuildCalled = false;
      let dockerPushCalled = false;
      
      mockSpawn.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[0] === 'build') {
          dockerBuildCalled = true;
        }
        if (cmd === 'docker' && args[0] === 'push') {
          dockerPushCalled = true;
        }
        
        return {
          pid: 12345,
          on: vi.fn((event, callback) => {
            if (event === 'exit') {
              setTimeout(() => callback(0), 10);
            }
          }),
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() }
        };
      });

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          frontend: {
            deployment: { type: 'container' },
            image: 'frontend:latest',
            registry: 'localhost:5000'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',        output: 'json',
        tag: 'v1.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      await publish(serviceDeployments, options);

      // Verify Docker commands were called
      expect(dockerBuildCalled || dockerPushCalled).toBe(true);
    });

    it('should only push images when skipBuild is true', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;
      
      let dockerBuildCalled = false;
      
      mockSpawn.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[0] === 'build') {
          dockerBuildCalled = true;
        }
        
        return {
          pid: 12345,
          on: vi.fn((event, callback) => {
            if (event === 'exit') {
              setTimeout(() => callback(0), 10);
            }
          }),
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() }
        };
      });

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' },
            image: 'backend:latest'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',        output: 'table',
        tag: 'v2.0.0',
        skipBuild: true,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      // Build should not be called with skipBuild=true
      expect(dockerBuildCalled).toBe(false);
      expect(result.services[0]!.metadata.skipBuild).toBe(true);
    });
  });

  describe('Service Selection', () => {
    it('should publish all services when service is "all"', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { 
            deployment: { type: 'container' },
            image: 'frontend:latest'
          },
          backend: { 
            deployment: { type: 'container' },
            image: 'backend:latest'
          },
          worker: { 
            deployment: { type: 'container' },
            image: 'worker:latest'
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'test',        output: 'json',
        tag: 'test-build',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services).toHaveLength(3);
      expect(result.summary.total).toBe(3);
      
      const serviceNames = result.services.map(s => s.service).sort();
      expect(serviceNames).toEqual(['backend', 'frontend', 'worker']);
      
      result.services.forEach(service => {
        expect(service.metadata?.tag).toBe('test-build');
      });
    });

    it('should publish specific service when named', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } },
          backend: { deployment: { type: 'container' } }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'test',        output: 'table',
        tag: 'latest',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe('backend');
      expect(result.summary.total).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle ECR authentication failures', async () => {
      const { ECRClient } = await import('@aws-sdk/client-ecr');
      const mockECRClient = {
        send: vi.fn().mockRejectedValue(new Error('ECR authentication failed'))
      };
      (ECRClient as any).mockImplementation(() => mockECRClient);

      await createTestEnvironment('production', {
        deployment: { default: 'aws' },
        services: {
          frontend: {
            deployment: { type: 'aws' }
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'production',        output: 'summary',
        tag: 'v1.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('ECR authentication failed')
      });

      expect(result.summary.failed).toBe(1);
    });

    it('should handle Docker build failures', async () => {
      const { spawn } = await import('child_process');
      const mockSpawn = spawn as any;
      
      mockSpawn.mockImplementation(() => ({
        pid: 12345,
        on: vi.fn((event, callback) => {
          if (event === 'exit') {
            setTimeout(() => callback(1), 10); // Exit code 1 indicates failure
          }
        }),
        stdout: { on: vi.fn() },
        stderr: { 
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('Docker build failed');
          })
        }
      }));

      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          backend: {
            deployment: { type: 'container' }
          }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',        output: 'table',
        tag: 'broken',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!.success).toBe(false);
      expect(result.summary.failed).toBe(1);
    });
  });

  describe('Output Format Support', () => {
    it('should support all output formats', async () => {
      await createTestEnvironment('test', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { publish } = await import('../commands/publish.js');

      const formats: Array<'summary' | 'table' | 'json' | 'yaml'> = ['summary', 'table', 'json', 'yaml'];
      
      for (const format of formats) {
        const options: PublishOptions = {
          environment: 'test',          output: format,
          tag: 'test',
          skipBuild: false,
          verbose: false,
          dryRun: false
        };

        const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);
        
        expect(result).toMatchObject({
          command: 'publish',
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

  describe('Tag Management', () => {
    it('should use custom tag when provided', async () => {
      await createTestEnvironment('production', {
        deployment: { default: 'container' },
        services: {
          frontend: { deployment: { type: 'container' } }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'production',        output: 'json',
        tag: 'v3.2.1-release',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!.metadata?.tag).toBe('v3.2.1-release');
      expect(result.services[0]!.metadata?.tag).toBe('v3.2.1-release');
    });

    it('should use default tag when not provided', async () => {
      await createTestEnvironment('staging', {
        deployment: { default: 'container' },
        services: {
          backend: { deployment: { type: 'container' } }
        }
      });

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',        output: 'yaml',
        tag: 'latest',
        skipBuild: false,
        verbose: false,
        dryRun: false
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!.metadata?.tag).toBe('latest');
    });
  });
});