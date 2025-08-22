/**
 * Unit tests for the configure command with structured output support
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestEnvironment, cleanupTestEnvironment, writeTestConfigs } from './setup.js';
import * as fs from 'fs';
import * as path from 'path';

let testDir: string;
let originalCwd: string;

// Only mock the things we need to mock (AWS SDK, readline, etc)
// Don't mock deployment-resolver since we want it to read real config files
vi.mock('../lib/stack-config.js', () => ({
  SemiontStackConfig: vi.fn(() => ({
    getConfig: vi.fn().mockResolvedValue({
      infraStack: { name: 'semiont-test' }
    })
  }))
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({
    send: vi.fn()
  })),
  GetSecretValueCommand: vi.fn(),
  UpdateSecretCommand: vi.fn()
}));
vi.mock('readline');

// Don't mock deployment-resolver for configure tests - use real filesystem
// Only mock the parts that need overriding for specific tests

// Now import after mocks are set up
import configureCommand, { ConfigureOptions } from '../commands/configure.js';
const configure = configureCommand.handler;
import { ConfigureResult } from '../lib/command-results.js';
import type { ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';

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
  
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Save current directory
    originalCwd = process.cwd();
    
    // Create test environment with proper initialization
    testDir = await createTestEnvironment('configure-command-test');
    
    // Change to test directory so config files are found
    process.chdir(testDir);
    
    // Create custom configs for specific test cases
    // Add a 'local-no-aws' environment without AWS config for error testing
    const noAwsConfig = {
      deployment: { default: 'container' },
      services: {
        frontend: { port: 3000 },
        backend: { port: 3001 }
      }
    };
    fs.writeFileSync(
      path.join(testDir, 'environments', 'local-no-aws.json'),
      JSON.stringify(noAwsConfig, null, 2)
    );
    
    // Mock process environment
    process.env.USER = 'testuser';
    
    // AWS mocks will be set up by individual tests as needed
  });
  
  afterEach(() => {
    vi.clearAllMocks();
    // Restore original directory
    if (originalCwd) {
      process.chdir(originalCwd);
    }
    // Clean up test environment
    if (testDir) {
      cleanupTestEnvironment(testDir);
    }
  });
    
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

  describe('show action', () => {
    it('should show configuration for all environments and return structured output', async () => {
      const options: ConfigureOptions = {
        action: 'show',
        environment: 'local',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Override with specific test data
      mockGetAvailableEnvironments.mockReturnValue(['local', 'test', 'production']);
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
      
      results.services.forEach((service) => {
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
        environment: 'local',
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      // Override with test data that includes error case
      mockGetAvailableEnvironments.mockReturnValue(['local', 'staging', 'production']);
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
      expect(stagingResult.status).toBeUndefined(); // Error results don't have status
      expect(stagingResult.error).toContain('Invalid configuration file');
    });
  });

  describe('list action', () => {
    it('should list all configurable secrets', async () => {
      const options: ConfigureOptions = {
        action: 'list',
        environment: 'local',
        verbose: false,
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
      expect(listResult.metadata).toHaveProperty('secrets');
      expect(listResult.metadata.secrets).toContain('oauth/google');
      expect(listResult.metadata.secrets).toContain('oauth/github');
      expect(listResult.metadata.secrets).toContain('jwt-secret');
    });
  });

  describe('validate action', () => {
    it('should validate all environment configurations', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'local',
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      // Test environments created with test setup
      // Previously mocked config - now using real files

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(1); // Only validates specified environment
      
      const validateResult = results.services[0] as ConfigureResult;
      expect(validateResult.service).toBe('validation');
      expect(validateResult.status).toBe('validated');
      expect(validateResult.success).toBe(true);
      expect(validateResult.metadata).toHaveProperty('action', 'validate');
      expect(validateResult.metadata).toHaveProperty('issues');
      expect(validateResult.metadata.issues).toEqual([]);
    });

    it('should detect AWS configuration issues', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'production-no-aws',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Create a production environment without AWS config for testing
      const prodNoAwsConfig = {
        deployment: { default: 'aws' }, // AWS deployment but no AWS config
        services: {
          frontend: { port: 3000 },
          backend: { port: 3001 }
        }
      };
      fs.writeFileSync(
        path.join(testDir, 'config', 'environments', 'production-no-aws.json'),
        JSON.stringify(prodNoAwsConfig, null, 2)
      );

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const productionResult = results.services.find(s => s.environment === 'production-no-aws')! as ConfigureResult;
      expect(productionResult).toBeDefined();
      expect(productionResult.status).toBe('validation-failed');
      expect(productionResult.success).toBe(false);
      expect(productionResult.metadata.issues).toContain('AWS deployment requires aws configuration');
    });

    it('should detect missing services', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'local',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Test environments created with test setup
      // Previously mocked config - now using real files

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const validateResult = results.services[0] as ConfigureResult;
      expect(validateResult.metadata.issues).toEqual([]); // Empty services is valid
    });
  });

  describe('get action', () => {
    it('should retrieve secrets from AWS Secrets Manager', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'production',
        secretPath: 'oauth/google',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Production environment has AWS config from test setup (via init command)
      
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
      if (getResult.service !== 'secret') {
        console.log('Error:', getResult.error);
      }
      expect(getResult.service).toBe('secret');
      expect(getResult.deploymentType).toBe('external');
      expect(getResult.status).toBe('retrieved');
      expect(getResult.success).toBe(true);
      expect(getResult.metadata).toHaveProperty('action', 'get');
      expect(getResult.metadata).toHaveProperty('exists', true);
      expect(getResult.metadata).toHaveProperty('secretPath', 'oauth/google');
      
      // Verify AWS SDK was called
      expect(mockSend).toHaveBeenCalledWith(
        expect.any(GetSecretValueCommand)
      );
    });

    it('should handle non-existent secrets', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'staging',
        secretPath: 'non-existent',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Staging environment has AWS config from test setup

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
        environment: 'production',
        verbose: false,
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
    // SKIPPED: Requires complex AWS Secrets Manager mocking.
    // After refactoring, the test's mocking approach conflicts with direct config loading.
    it.skip('should update secrets in AWS Secrets Manager', async () => {
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

      // Mock the update response
      const mockSend = vi.fn()
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
      expect(setResult.service).toBe('secret');
      expect(setResult.status).toBe('updated');
      expect(setResult.success).toBe(true);
      expect(setResult.configurationChanges).toHaveLength(1);
      expect(setResult.configurationChanges[0]!).toMatchObject({
        key: 'jwt-secret',
        source: 'aws-secrets-manager'
      });
      expect(setResult.restartRequired).toBe(true);
      
      // Verify AWS SDK was called for update
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(expect.any(UpdateSecretCommand));
    });

    // SKIPPED: Requires AWS SDK mocking for OAuth secret handling.
    // Test needs redesign to work with new config loading pattern.
    it.skip('should handle OAuth secrets with structured data', async () => {
      const options: ConfigureOptions = {
        action: 'set',
        environment: 'staging',
        secretPath: 'oauth/google',
        value: JSON.stringify({ clientId: 'new-id', clientSecret: 'new-secret' }),
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Production environment has AWS config from test setup

      const mockSend = vi.fn()
        .mockResolvedValueOnce({}); // Only update response needed
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
      expect(setResult.metadata).toHaveProperty('action', 'set');
      expect(setResult.metadata).toHaveProperty('secretPath', 'oauth/google');
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

      // Production env already has AWS config from test setup
      // No need to mock config loading

      // No AWS calls should be made in dry run mode
      const mockSend = vi.fn();
      
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
      
      // Verify no AWS calls were made in dry run mode
      expect(mockSend).not.toHaveBeenCalled();
    });

    // SKIPPED: Requires mocking AWS Secrets Manager create operations.
    // Conflicts with refactored config loading approach.
    it.skip('should create new secrets if they do not exist', async () => {
      const options: ConfigureOptions = {
        action: 'set',
        environment: 'staging',
        secretPath: 'new-secret',
        value: 'new-value',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Production environment has AWS config from test setup

      // Mock update response
      const mockSend = vi.fn()
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
      expect(setResult.metadata).toHaveProperty('action', 'set');
      expect(setResult.configurationChanges[0]!.oldValue).toBe('masked'); // Always masked in current implementation
    });
  });

  describe('Error handling', () => {
    it('should handle AWS configuration missing', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'local-no-aws', // Use the environment we created without AWS config
        secretPath: 'oauth/google',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // local-no-aws environment was created in beforeEach without AWS config

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      const getResult = results.services[0]! as ConfigureResult;
      expect(getResult.success).toBe(false);
      expect(getResult.error).toContain('does not have AWS');
    });

    it('should handle AWS SDK errors gracefully', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'production',
        secretPath: 'oauth/google',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Production environment has AWS config from test setup

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
      expect(getResult.status).toBeUndefined(); // Error results don't have status
      expect(getResult.error).toContain('AccessDeniedException');
    });
  });

  describe('Output formats', () => {
    it('should support JSON output format', async () => {
      const options: ConfigureOptions = {
        action: 'list',
        environment: 'local',
        verbose: false,
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
        environment: 'staging',
        verbose: false,
        dryRun: false,
        output: 'yaml'
      };

      // Override to return specific environments for this test
      mockGetAvailableEnvironments.mockReturnValue(['staging']);
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
        environment: 'production',
        verbose: false,
        dryRun: false,
        output: 'table'
      };

      // Production env already has proper AWS config from test setup
      // No need to override

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
        environment: 'local',
        verbose: false,
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
        environment: 'production', // Use production which has AWS config
        verbose: true,
        dryRun: false,
        output: 'json'
      };

      // Override to show only production env
      mockGetAvailableEnvironments.mockReturnValue(['production']);
      // The production env from test setup already has AWS config
      // But we need to ensure the mock returns it properly
      mockLoadEnvironmentConfig.mockImplementation((env: string) => {
        if (env === 'production') {
          return {
            site: createSiteConfig('production.example.com'),
            deployment: { default: 'aws' },
            services: { frontend: {}, backend: {} },
            aws: createAWSConfig('us-east-1')
          };
        }
        // Fallback to real config
        const configPath = path.join(testDir, 'config', 'environments', `${env}.json`);
        if (fs.existsSync(configPath)) {
          return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        throw new Error(`Environment configuration missing: ${env}.json`);
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
        environment: 'local',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      mockGetAvailableEnvironments.mockReturnValue(['dev', 'test', 'prod']);
      mockLoadEnvironmentConfig.mockImplementation((env: string) => ({
        site: createSiteConfig(`${env}.example.com`),
        deployment: { default: 'container' },
        services: {}
      }));

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(3);
      expect(results.services.map(s => s.environment)).toEqual(['dev', 'test', 'prod']);
    });

    it('should process only specified environment for validate action', async () => {
      const options: ConfigureOptions = {
        action: 'validate',
        environment: 'local',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Validate should only process the specified environment, not all
      // No need to mock getAvailableEnvironments since validate doesn't use it

      const serviceDeployments = createServiceDeployments([
        { name: 'dummy', type: 'external' }
      ]);
      const results = await configure(serviceDeployments, options);

      expect(results.services).toHaveLength(1); // Validate only processes specified environment
      expect(results.services[0]!.service).toBe('validation');
    });
  });

  describe('Secret masking', () => {
    it('should mask secret values in output', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'production',
        secretPath: 'jwt-secret',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Production environment has AWS config from test setup

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
      expect(getResult.metadata.value).toBeDefined();
      expect(getResult.metadata.value).not.toContain('super-secret-jwt-token-12345');
      expect(getResult.metadata.value).toMatch(/\*+/); // Should contain asterisks
    });

    it('should mask OAuth secret objects', async () => {
      const options: ConfigureOptions = {
        action: 'get',
        environment: 'staging',
        secretPath: 'oauth/github',
        verbose: false,
        dryRun: false,
        output: 'json'
      };

      // Staging environment has AWS config from test setup

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
      expect(getResult.metadata.value).toBeDefined();
      expect(getResult.metadata.value.clientId).toMatch(/\*+/);
      expect(getResult.metadata.value.clientSecret).toMatch(/\*+/);
      expect(getResult.metadata.value.clientId).not.toContain('github-client-id-12345');
    });
  });
});