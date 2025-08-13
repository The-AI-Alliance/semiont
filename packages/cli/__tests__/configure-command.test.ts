/**
 * Unit tests for the configure command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure, ConfigureOptions } from '../commands/configure.js';
import { ConfigureResult } from '../lib/command-results.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import * as deploymentResolver from '../lib/deployment-resolver.js';
import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';
// import * as readline from 'readline';
// Mock dependencies
vi.mock('../lib/deployment-resolver.js');
vi.mock('../lib/stack-config.js', () => ({
  SemiontStackConfig: vi.fn().mockImplementation(() => ({
    getConfig: vi.fn().mockResolvedValue({
      infraStack: { name: 'semiont-test' }
    })
  }))
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: vi.fn()
  })),
  GetSecretValueCommand: vi.fn(),
  UpdateSecretCommand: vi.fn()
}));
vi.mock('readline');

// Helper function to create dummy service deployments for tests
function createServiceDeployments(services: Array<{name: string, type: string, config?: any}>): ServiceDeploymentInfo[] {
  return services.map(service => ({
    name: service.name,
    deploymentType: service.type as any,
    deployment: { type: service.type },
    config: service.config || {}
  }));
}

describe('configure command with structured output', () => {
  const mockLoadEnvironmentConfig = vi.mocked(deploymentResolver.loadEnvironmentConfig);
  const mockGetAvailableEnvironments = vi.mocked(deploymentResolver.getAvailableEnvironments);
    
  // Helper to create valid site config
  function createSiteConfig(domain: string) {
    return {
      domain,
      siteName: 'Test Site',
      adminEmail: 'admin@example.com'
    };
  }

  // Helper to create valid AWS config
  function createAWSConfig(region: string = 'us-east-1') {
    return {
      region,
      accountId: '123456789012'
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mocks
    mockGetAvailableEnvironments.mockReturnValue(['local', 'staging', 'production']);
    
    // Mock process environment
    process.env.USER = 'testuser';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('show action', () => {
    it('should show configuration for all environments and return structured output', async () => {
      const options: ConfigureOptions = {
        action: 'show',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockImplementation((env: string) => {
        const config: any = {
          site: createSiteConfig(`${env}.example.com`),
          deployment: { default: env === 'production' ? 'aws' : 'container' },
          services: {
            frontend: { deployment: { type: 'container' } },
            backend: { deployment: { type: 'container' } }
          }
        };
        if (env === 'production') {
          config.aws = createAWSConfig();
        }
        return config;
      });

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('configure');
      expect(results.services).toHaveLength(3); // One for each environment
      
      results.services.forEach((service, index) => {
        const configResult = service as ConfigureResult;
        expect(configResult.status).toBe('shown');
        expect(configResult.metadata).toHaveProperty('action', 'show');
        expect(configResult.metadata).toHaveProperty('domain');
        expect(configResult.metadata).toHaveProperty('deployment');
        expect(configResult.metadata).toHaveProperty('services');
      });
    });

    it('should handle configuration errors gracefully', async () => {
      const options: ConfigureOptions = {
        action: 'show',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      mockLoadEnvironmentConfig.mockImplementation((env: string) => {
        if (env === 'staging') {
          throw new Error('Invalid configuration file');
        }
        return {
          site: createSiteConfig(`${env}.example.com`),
          deployment: { default: 'container' },
          services: {}
        };
      });

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(3);
      
      const stagingResult = results.services.find(s => s.environment === 'staging')! as ConfigureResult;
      expect(stagingResult).toBeDefined();
      expect(stagingResult.success).toBe(false);
      expect(stagingResult.status).toBe('failed');
      expect(stagingResult.error).toContain('Invalid configuration file');
    });
  });

  describe('list action', () => {
    it('should list all configurable secrets', async () => {
      const options: ConfigureOptions = {
        action: 'list',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      
      const listResult = results.services[0]! as ConfigureResult;
      expect(listResult.service).toBe('secrets');
      expect(listResult.status).toBe('listed');
      expect(listResult.metadata).toHaveProperty('action', 'list');
      expect(listResult.metadata).toHaveProperty('availableSecrets');
      expect(listResult.metadata.availableSecrets).toContain('oauth/google');
      expect(listResult.metadata.availableSecrets).toContain('oauth/github');
      expect(listResult.metadata.availableSecrets).toContain('jwt-secret');
    });
  });

  describe('validate action', () => {
    it('should validate all environment configurations', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'table'
      };

      mockLoadEnvironmentConfig.mockImplementation((env: string) => ({
        site: createSiteConfig(`${env}.example.com`),
        deployment: { default: 'container' },
        services: {
          frontend: {},
          backend: {}
        }
      }));

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(3); // One validation result per environment
      
      results.services.forEach(service => {
        const validateResult = service as ConfigureResult;
        expect(validateResult.service).toBe('validation');
        expect(validateResult.status).toBe('valid');
        expect(validateResult.success).toBe(true);
        expect(validateResult.metadata).toHaveProperty('action', 'validate');
        expect(validateResult.metadata).toHaveProperty('servicesCount', 2);
      });
    });

    it('should detect AWS configuration issues', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'production',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockImplementation((env: string) => ({
        site: createSiteConfig(`${env}.example.com`),
        deployment: { default: 'aws' }, // AWS deployment but no AWS config
        services: {
          frontend: {},
          backend: {}
        }
      }));

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const productionResult = results.services.find(s => s.environment === 'production')! as ConfigureResult;
      expect(productionResult).toBeDefined();
      expect(productionResult.status).toBe('invalid');
      expect(productionResult.success).toBe(false);
      expect(productionResult.metadata.issues).toContain('AWS deployment specified but no AWS configuration');
    });

    it('should detect missing services', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockImplementation((env: string) => ({
        site: createSiteConfig(`${env}.example.com`),
        deployment: { default: 'container' },
        // No services defined
        services: {}
      }));

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      results.services.forEach(service => {
        const validateResult = service as ConfigureResult;
        expect(validateResult.metadata.issues).toContain('No services defined');
      });
    });
  });

  describe('get action', () => {
    it('should retrieve secrets from AWS Secrets Manager', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'production',
        secretPath: 'oauth/google',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: { region: 'us-east-1', accountId: '123456789012' },
        services: {}
      });

      // Mock AWS Secrets Manager
      const mockSend = vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret'
        })
      });
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      
      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.service).toBe('oauth/google');
      expect(getResult.deploymentType).toBe('aws');
      expect(getResult.status).toBe('retrieved');
      expect(getResult.success).toBe(true);
      expect(getResult.metadata).toHaveProperty('action', 'get');
      expect(getResult.metadata).toHaveProperty('exists', true);
      expect(getResult.metadata).toHaveProperty('type', 'object');
      
      // Verify AWS SDK was called
      expect(mockSend).toHaveBeenCalledWith(
        expect.any(GetSecretValueCommand)
      );
    });

    it('should handle non-existent secrets', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'staging',
        secretPath: 'non-existent',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: { region: 'us-east-1', accountId: '123456789012' },
        services: {}
      });

      // Mock AWS Secrets Manager to throw ResourceNotFoundException
      const mockSend = vi.fn().mockRejectedValue({
        name: 'ResourceNotFoundException',
        message: 'Secret not found'
      });
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      
      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.status).toBe('not-found');
      expect(getResult.success).toBe(false);
      expect(getResult.metadata).toHaveProperty('exists', false);
    });

    it('should require secret path for get action', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'production',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.success).toBe(false);
      expect(getResult.error).toContain('Secret path is required');
    });
  });

  describe('set action', () => {
    it('should update secrets in AWS Secrets Manager', async () => {
      const options: ConfigureOptions = {
        action: 'set',
        environment: 'production',
        secretPath: 'jwt-secret',
        value: 'new-secret-value',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: createAWSConfig('us-east-1'),
        services: {}
      });

      // Mock getting current secret
      const mockSend = vi.fn()
        .mockResolvedValueOnce({
          SecretString: 'old-secret-value'
        })
        .mockResolvedValueOnce({}); // Update response
      
      // Mock the SecretsManagerClient instance
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(1);
      
      const setResult = results.services[0]! as ConfigureResult;
      expect(setResult.service).toBe('jwt-secret');
      expect(setResult.status).toBe('updated');
      expect(setResult.success).toBe(true);
      expect(setResult.configurationChanges).toHaveLength(1);
      expect(setResult.configurationChanges[0]!).toMatchObject({
        key: 'jwt-secret',
        source: 'aws-secrets-manager'
      });
      expect(setResult.restartRequired).toBe(true);
      
      // Verify AWS SDK was called for both get and update
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledWith(expect.any(UpdateSecretCommand));
    });

    it('should handle OAuth secrets with structured data', async () => {
      const options: ConfigureOptions = {
        action: 'set',
        environment: 'staging',
        secretPath: 'oauth/google',
        value: JSON.stringify({ clientId: 'new-id', clientSecret: 'new-secret' }),
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: { region: 'us-east-1', accountId: '123456789012' },
        services: {}
      });

      const mockSend = vi.fn()
        .mockResolvedValueOnce({
          SecretString: JSON.stringify({ clientId: 'old-id', clientSecret: 'old-secret' })
        })
        .mockResolvedValueOnce({});
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const setResult = results.services[0]! as ConfigureResult;
      expect(setResult.status).toBe('updated');
      expect(setResult.metadata).toHaveProperty('wasExisting', true);
    });

    it('should handle dry run mode for set action', async () => {
      const options: ConfigureOptions = {
        action: 'set',
        environment: 'production',
        secretPath: 'app-secrets',
        value: 'test-value',
        verbose: false,
        dryRun: true,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: createAWSConfig('us-east-1'),
        services: {}
      });

      // Mock getting current secret
      const mockSend = vi.fn().mockResolvedValueOnce({
        SecretString: 'current-value'
      });
      
      // Mock the SecretsManagerClient instance
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const setResult = results.services[0]! as ConfigureResult;
      expect(setResult.status).toBe('dry-run');
      expect(setResult.metadata).toHaveProperty('dryRun', true);
      
      // Verify only get was called, not update
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(expect.any(GetSecretValueCommand));
      expect(mockSend).not.toHaveBeenCalledWith(expect.any(UpdateSecretCommand));
    });

    it('should create new secrets if they do not exist', async () => {
      const options: ConfigureOptions = {
        action: 'set',
        environment: 'staging',
        secretPath: 'new-secret',
        value: 'new-value',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: { region: 'us-east-1', accountId: '123456789012' },
        services: {}
      });

      // Mock secret not existing initially
      const mockSend = vi.fn()
        .mockRejectedValueOnce({
          name: 'ResourceNotFoundException'
        })
        .mockResolvedValueOnce({}); // Update response
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const setResult = results.services[0]! as ConfigureResult;
      expect(setResult.status).toBe('updated');
      expect(setResult.metadata).toHaveProperty('wasExisting', false);
      expect(setResult.configurationChanges[0]!.oldValue).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('should handle AWS configuration missing', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'local',
        secretPath: 'oauth/google',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        // No AWS configuration
        deployment: { default: 'container' },
        services: {}
      });

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.success).toBe(false);
      expect(getResult.error).toContain('does not have AWS configuration');
    });

    it('should handle AWS SDK errors gracefully', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'production',
        secretPath: 'oauth/google',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: { region: 'us-east-1', accountId: '123456789012' },
        services: {}
      });

      // Mock AWS error
      const mockSend = vi.fn().mockRejectedValue(new Error('AccessDeniedException'));
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.success).toBe(false);
      expect(getResult.status).toBe('failed');
      expect(getResult.error).toContain('AccessDeniedException');
    });
  });

  describe('Output formats', () => {
    it('should support JSON output format', async () => {
      const options: ConfigureOptions = {
        action: 'list',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('configure');
      expect(results.environment).toBe('local');
      expect(results.services).toBeInstanceOf(Array);
    });

    it('should support YAML output format', async () => {
      const options: ConfigureOptions = {
        action: 'show',
        environment: 'staging',        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        site: createSiteConfig('staging.example.com'),
        services: {}
      });

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.command).toBe('configure');
    });

    it('should support table output format', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'production',        verbose: false,
        dryRun: false,
        output: 'table'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        deployment: { default: 'aws' },
        aws: createAWSConfig('us-east-1'),
        services: { frontend: {}, backend: {} }
      });

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results).toBeDefined();
      expect(results.services).toBeDefined();
    });

    it('should support summary output format', async () => {
      const options: ConfigureOptions = {
        action: 'list',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'summary'
      };

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.command).toBe('configure');
      // Summary format still returns structured data
      expect(results.summary.total).toBeGreaterThan(0);
    });
  });

  describe('Verbose mode', () => {
    it('should include additional metadata in verbose mode', async () => {
      const options: ConfigureOptions = {
        action: 'show',
        environment: 'local',        verbose: true,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        site: createSiteConfig('local.example.com'),
        deployment: { default: 'container' },
        services: { frontend: {}, backend: {} },
        aws: createAWSConfig('us-east-1')
      });

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const showResult = results.services[0]! as ConfigureResult;
      expect(showResult.metadata).toHaveProperty('awsRegion', 'us-east-1');
    });
  });

  describe('Multiple environments', () => {
    it('should process all environments for show action', async () => {
      const options: ConfigureOptions = {
        action: 'show',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockGetAvailableEnvironments.mockReturnValue(['dev', 'test', 'prod']);
      mockLoadEnvironmentConfig.mockImplementation((env: string) => ({
        site: createSiteConfig(`${env}.example.com`),
        services: {}
      }));

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(3);
      expect(results.services.map(s => s.environment)).toEqual(['dev', 'test', 'prod']);
    });

    it('should process all environments for validate action', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'local',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockGetAvailableEnvironments.mockReturnValue(['alpha', 'beta']);
      mockLoadEnvironmentConfig.mockImplementation((env: string) => ({
        deployment: { default: 'container' },
        services: { api: {} }
      }));

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(2);
      expect(results.services.every(s => s.service === 'validation')).toBe(true);
    });
  });

  describe('Secret masking', () => {
    it('should mask secret values in output', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'production',
        secretPath: 'jwt-secret',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: { region: 'us-east-1', accountId: '123456789012' },
        services: {}
      });

      const mockSend = vi.fn().mockResolvedValue({
        SecretString: 'super-secret-jwt-token-12345'
      });
      
      // Mock the SecretsManagerClient instance
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.metadata.masked).toBeDefined();
      expect(getResult.metadata.masked).not.toContain('super-secret-jwt-token-12345');
      expect(getResult.metadata.masked).toMatch(/\*+/); // Should contain asterisks
    });

    it('should mask OAuth secret objects', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'staging',
        secretPath: 'oauth/github',        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockLoadEnvironmentConfig.mockReturnValue({
        aws: { region: 'us-east-1', accountId: '123456789012' },
        services: {}
      });

      const mockSend = vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({
          clientId: 'github-client-id-12345',
          clientSecret: 'github-client-secret-abcdef'
        })
      });
      const mockClient = {
        send: mockSend
      };
      (SecretsManagerClient as any).mockImplementation(() => mockClient);

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.metadata.masked).toBeDefined();
      expect(getResult.metadata.masked!.clientId).toMatch(/\*+/);
      expect(getResult.metadata.masked!.clientSecret).toMatch(/\*+/);
      expect(getResult.metadata.masked!.clientId).not.toContain('github-client-id-12345');
    });
  });
});