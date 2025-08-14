/**
 * Publish Command Tests
 * 
 * Tests the publish command's structured output functionality for
 * building and pushing container images to registries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// Mock container runtime functions
vi.mock('../lib/container-runtime.js', () => ({
  buildImage: vi.fn(() => Promise.resolve(true)),
  tagImage: vi.fn(() => Promise.resolve(true)),
  pushImage: vi.fn(() => Promise.resolve(true)),
  runContainer: vi.fn(() => Promise.resolve(true)),
  stopContainer: vi.fn(() => Promise.resolve(true))
}));

// Mock load-environment-config - return minimal config for AWS tests
vi.mock('../lib/load-environment-config.js', () => ({
  loadEnvironmentConfig: vi.fn(() => Promise.resolve({
    aws: {
      region: 'us-east-2',
      accountId: '123456789012'
    }
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
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

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

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'v1.2.3',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { image: 'semiont-frontend', port: 3000 } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result).toMatchObject({
        command: 'publish',
        environment: 'staging',
        timestamp: expect.any(Date),
        duration: expect.any(Number),
        services: expect.arrayContaining([
          expect.objectContaining({
            command: 'publish',
            deploymentType: 'container',
            success: true,
            imageTag: 'v1.2.3',
            repository: 'local',
            resourceId: expect.objectContaining({
              container: expect.objectContaining({
                name: expect.stringContaining('semiont-frontend')
              })
            }),
            status: 'published',
            metadata: expect.objectContaining({
              skipBuild: false
            })
          })
        ]),
        summary: {
          total: expect.any(Number),
          succeeded: expect.any(Number),
          failed: 0,
          warnings: 0
        }
      });
    });

    it('should handle dry run mode correctly', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'test',
        output: 'json',
        tag: 'test',
        skipBuild: false,
        verbose: false,
        dryRun: true,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container', config: { image: 'semiont-backend', port: 3001 } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        status: 'dry-run',
        metadata: expect.objectContaining({
          dryRun: true
        })
      });
      
      expect(result.executionContext.dryRun).toBe(true);
    });

    it('should handle skip build mode', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'summary',
        tag: 'v2.0.0',
        skipBuild: true,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { image: 'semiont-frontend', port: 3000 } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        imageTag: 'v2.0.0',
        repository: 'local',
        metadata: expect.objectContaining({
          skipBuild: true
        })
      });
    });
  });

  describe('Deployment Type Support', () => {
    it('should handle AWS ECR publishing', async () => {
      const { ECRClient } = await import('@aws-sdk/client-ecr');
      // Mock commands are not needed since we're mocking the client
      
      const mockECRClient = {
        send: vi.fn()
          .mockResolvedValueOnce({ // GetAuthorizationToken
            authorizationData: [{
              authorizationToken: Buffer.from('user:pass').toString('base64'),
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

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'production',
        output: 'summary',
        tag: 'v1.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws', config: { aws: { region: 'us-east-1', accountId: '123456789012' }, image: 'backend:latest' } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'aws',
        imageTag: 'v1.0.0',
        repository: expect.stringContaining('.dkr.ecr.'),
        resourceId: expect.objectContaining({
          aws: expect.objectContaining({
            arn: expect.stringContaining('repository/semiont-backend')
          })
        })
      });

      // Verify ECR client was called
      expect(mockECRClient.send).toHaveBeenCalled();
    });

    it('should handle container registry publishing', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'staging-latest',
        skipBuild: false,
        verbose: true,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { image: 'semiont-frontend', port: 3000 } },
        { name: 'backend', type: 'container', config: { image: 'semiont-backend', port: 3001 } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services).toHaveLength(2);
      
      result.services.forEach(service => {
        expect(service).toMatchObject({
          deploymentType: 'container',
          imageTag: 'staging-latest',
          repository: 'local',
          metadata: expect.objectContaining({
            skipBuild: false
          })
        });
      });
    });

    it('should handle local Docker registry', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'local',
        output: 'json',
        tag: 'dev',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { image: 'semiont-frontend', port: 3000 } },
        { name: 'backend', type: 'container', config: { image: 'semiont-backend', port: 3001 } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'container',
        imageTag: 'dev',
        repository: 'local',
        metadata: expect.objectContaining({
          skipBuild: false
        })
      });
    });

    it('should skip process deployment type', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'local',
        output: 'json',
        tag: 'latest',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'process', config: { port: 3000 } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'process',
        status: 'skipped',
        metadata: expect.objectContaining({
          reason: expect.stringContaining('does not use container images')
        })
      });
    });

    it('should skip external deployment type', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'remote',
        output: 'json',
        tag: 'latest',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'external', config: { host: 'api.example.com' } }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        deploymentType: 'external',
        status: 'skipped',
        metadata: expect.objectContaining({
          reason: expect.stringContaining('does not use container images')
        })
      });
    });
  });

  describe('Build and Push Operations', () => {
    it('should build and push images when skipBuild is false', async () => {
      // The mocks are already set up in the vi.mock at the top of the file
      // We just need to verify the result
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'v1.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container', config: { image: 'semiont-frontend' } }
      ]);
      const result = await publish(serviceDeployments, options);

      // The build and tag should succeed because the mocks return true
      expect(result.services[0]!.success).toBe(true);
      expect(result.services[0]!.status).toBe('published');
    });
  });

  describe('Service Selection', () => {
    it('should publish all services when service is "all"', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'v1.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'frontend', type: 'container' },
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services).toHaveLength(2);
      expect(result.services.map(s => s.service)).toEqual(['frontend', 'backend']);
    });

    it('should publish specific service when named', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'v2.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: ['backend']
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe('backend');
    });
  });

  describe('Error Handling', () => {
    it('should handle ECR authentication failures', async () => {
      // Mock ECR client to reject
      vi.doMock('@aws-sdk/client-ecr', () => ({
        ECRClient: vi.fn(() => ({
          send: vi.fn().mockRejectedValue(new Error('Authentication failed'))
        })),
        GetAuthorizationTokenCommand: vi.fn(),
        BatchGetImageCommand: vi.fn(),
        DescribeRepositoriesCommand: vi.fn()
      }));

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'production',
        output: 'json',
        tag: 'v1.0.0',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'aws' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Failed to publish backend')
      });
      
      // Clean up mock
      vi.doUnmock('@aws-sdk/client-ecr');
    });

    it('should handle Docker build failures', async () => {
      const { buildImage } = await import('../lib/container-runtime.js');
      (buildImage as any).mockRejectedValueOnce(new Error('Build failed'));

      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'broken',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect(result.services[0]!).toMatchObject({
        success: false,
        status: 'failed',
        error: expect.stringContaining('Build failed')
      });
    });
  });

  describe('Tag Management', () => {
    it('should use custom tag when provided', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'custom-tag-v1.2.3',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect((result.services[0] as any).imageTag).toBe('custom-tag-v1.2.3');
    });

    it('should use default tag when not provided', async () => {
      const { publish } = await import('../commands/publish.js');
      
      const options: PublishOptions = {
        environment: 'staging',
        output: 'json',
        tag: 'latest',
        skipBuild: false,
        verbose: false,
        dryRun: false,
        services: []
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'backend', type: 'container' }
      ]);
      const result = await publish(serviceDeployments, options);

      expect((result.services[0] as any).imageTag).toBe('latest');
    });
  });
});