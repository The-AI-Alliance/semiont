/**
 * Configure Command
 * 
 * Manages service configuration including settings, secrets, and environment variables.
 * This command provides a unified interface for configuration management across all
 * platforms with proper secret handling.
 * 
 * Workflow:
 * 1. Loads existing configuration for service/environment
 * 2. Validates configuration schema
 * 3. Manages secrets securely (encryption, vaults)
 * 4. Updates configuration files or remote stores
 * 5. Optionally triggers service restart to apply changes
 * 
 * Options:
 * - --service: Specific service to configure
 * - --all: Configure all services
 * - --set: Set configuration values (key=value)
 * - --unset: Remove configuration keys
 * - --list: Show current configuration
 * - --secrets: Manage secret values securely
 * - --validate: Validate configuration without applying
 * 
 * Configuration Types:
 * - Environment variables: Runtime environment settings
 * - Application config: Service-specific settings
 * - Secrets: Sensitive data (API keys, passwords)
 * - Feature flags: Runtime feature toggles
 * - Platform config: Platform-specific settings
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { SemiontStackConfig } from '../platforms/aws/stack-config.js';
import { loadEnvironmentConfig, getAvailableEnvironments } from '../platforms/platform-resolver.js';
import { type EnvironmentConfig, hasAWSConfig } from '../platforms/environment-config.js';
import * as readline from 'readline';
import { printInfo, setSuppressOutput } from '../lib/cli-logger.js';
import { type Platform } from '../platforms/platform-resolver.js';
import type { PlatformResources } from '../platforms/platform-resources.js';
import type { ServiceName } from '../services/service-interface.js';
import { 
  CommandResults, 
  createBaseResult,
  createErrorResult 
} from '../commands/command-results.js';
import { CommandBuilder } from '../commands/command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../commands/base-options-schema.js';
import { PlatformFactory } from '../platforms/index.js';
import type { SecretOptions } from '../platforms/platform-strategy.js';

// =====================================================================
// RESULT TYPE DEFINITIONS
// =====================================================================

/**
 * Result of a configure operation
 */
export interface ConfigureResult {
  entity: ServiceName | string;  // Can be a service or other entity
  platform?: Platform;
  success: boolean;
  status?: string;  // Optional status for legacy commands
  configurationChanges: Array<{
    key: string;
    oldValue?: any;
    newValue: any;
    source: string;
  }>;
  restartRequired: boolean;
  resources?: PlatformResources;
  error?: string;
  metadata?: Record<string, any>;
}

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

export const ConfigureOptionsSchema = BaseOptionsSchema.extend({
  action: z.enum(['show', 'list', 'validate', 'get', 'set']).default('show'),
  secretPath: z.string().optional(),
  value: z.string().optional(),
});

// Type is inferred from the schema
export type ConfigureOptions = z.output<typeof ConfigureOptionsSchema>;

// =====================================================================
// CONSTANTS
// =====================================================================

// Known secrets and their descriptions
const KNOWN_SECRETS: Record<string, string> = {
  'oauth/google': 'Google OAuth client ID and secret',
  'oauth/github': 'GitHub OAuth client ID and secret', 
  'jwt-secret': 'JWT signing secret for API authentication',
  'app-secrets': 'Application secrets (session, NextAuth, etc.)',
  'admin-emails': 'Comma-separated list of admin email addresses',
  'admin-password': 'Admin password for direct login (non-OAuth)'
};

// =====================================================================
// UTILITY FUNCTIONS
// =====================================================================

function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return value.substring(0, 4) + '*'.repeat(value.length - 8) + value.substring(value.length - 4);
}

function maskSecretObject(obj: any): any {
  if (typeof obj === 'string') {
    return maskSecret(obj);
  }
  
  if (typeof obj === 'object' && obj !== null) {
    const masked: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        masked[key] = maskSecret(value);
      } else {
        masked[key] = maskSecretObject(value);
      }
    }
    return masked;
  }
  
  return obj;
}

/**
 * Determine which platform to use for secret management based on environment
 */
function determinePlatformForSecrets(environment: string): Platform {
  const envConfig = loadEnvironmentConfig(environment) as EnvironmentConfig;
  
  // Priority order:
  // 1. AWS if configured
  // 2. Container if docker/podman detected
  // 3. Process (local .env files) as fallback
  
  if (hasAWSConfig(envConfig)) {
    return 'aws' as Platform;
  }
  
  // Check for container runtime
  const fs = require('fs');
  if (fs.existsSync('/var/run/docker.sock') || fs.existsSync('/run/podman/podman.sock')) {
    return 'container' as Platform;
  }
  
  return 'process' as Platform;
}

async function getSecretFullName(environment: string, secretPath: string): Promise<string> {
  // Convert path format to actual secret name
  // oauth/google -> semiont-production-oauth-google-secret (or similar based on stack config)
  const stackConfig = new SemiontStackConfig(environment);
  const config = await stackConfig.getConfig();
  const stackName = config.infraStack.name;
  return `${stackName}-${secretPath.replace('/', '-')}-secret`;
}

/**
 * Platform-aware secret retrieval
 */
async function getPlatformSecret(environment: string, secretPath: string): Promise<any> {
  const platform = determinePlatformForSecrets(environment);
  const platformStrategy = PlatformFactory.getPlatform(platform);
  
  const options: SecretOptions = {
    environment,
    format: 'json'
  };
  
  const result = await platformStrategy.manageSecret('get', secretPath, undefined, options);
  
  if (!result.success) {
    if (result.error?.includes('not found')) {
      return null;
    }
    throw new Error(result.error || 'Failed to get secret');
  }
  
  return result.value;
}

/**
 * Platform-aware secret update
 */
async function setPlatformSecret(environment: string, secretPath: string, secretValue: any): Promise<void> {
  const platform = determinePlatformForSecrets(environment);
  const platformStrategy = PlatformFactory.getPlatform(platform);
  
  const options: SecretOptions = {
    environment,
    format: typeof secretValue === 'object' ? 'json' : 'string'
  };
  
  const result = await platformStrategy.manageSecret('set', secretPath, secretValue, options);
  
  if (!result.success) {
    throw new Error(result.error || 'Failed to update secret');
  }
}

// Platform-aware secret management has replaced the legacy AWS-specific implementation.
// Secrets are now managed through the platform strategy's manageSecret method.

// =====================================================================
// COMMAND IMPLEMENTATION
// =====================================================================

async function configure(
  options: ConfigureOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  // Load environment config once for all operations
  const envConfig = options.action !== 'show' ? loadEnvironmentConfig(options.environment || 'development') as EnvironmentConfig : null;
  
  // Suppress output for structured formats
  const previousSuppressOutput = setSuppressOutput(isStructuredOutput);
  
  try {
    if (!isStructuredOutput && options.output === 'summary') {
      printInfo(`Executing configure ${options.action} for ${colors.bright}${options.environment}${colors.reset} environment`);
    }
    
    // Create configuration results
    const configureResults: ConfigureResult[] = [];
    
    // Execute the appropriate action
    try {
      switch (options.action) {
        case 'show': {
          const environments = getAvailableEnvironments();
          for (const env of environments) {
            try {
              const config = loadEnvironmentConfig(env);
              const baseResult = createBaseResult('configure', 'configuration', 'external', env, startTime);
              const result: ConfigureResult = {
                ...baseResult,
                entity: baseResult.service,
                configurationChanges: [],
                restartRequired: false,
                resources: { platform: 'external', data: { endpoint: 'config-file' } },
                status: 'shown',
                metadata: {
                  action: 'show',
                  domain: config.site?.domain || 'Not configured',
                  platform: config.deployment?.default || 'Not specified',
                  services: Object.keys(config.services || {}),
                  awsRegion: config.aws?.region,
                },
              };
              configureResults.push(result);
              
              if (!isStructuredOutput && options.output === 'summary') {
                console.log(`\n${colors.bright}${env}:${colors.reset}`);
                console.log(`  Domain: ${config.site?.domain || 'Not configured'}`);
                console.log(`  Default platform: ${config.deployment?.default || 'Not specified'}`);
                console.log(`  Services: ${Object.keys(config.services || {}).join(', ') || 'None'}`);
                if (config.aws) {
                  console.log(`  AWS Region: ${config.aws.region || 'Not specified'}`);
                  console.log(`  AWS Account: ${config.aws.accountId || 'Not specified'}`);
                }
              }
            } catch (error) {
              if (!isStructuredOutput && options.output === 'summary') {
                console.log(`\n${colors.bright}${env}:${colors.reset} ${colors.red}Error loading config${colors.reset}`);
              }
              
              const baseResult = createBaseResult('configure', 'configuration', 'external', env, startTime);
              const errorBaseResult = createErrorResult(baseResult, error as Error);
              const result: ConfigureResult = {
                ...errorBaseResult,
                entity: errorBaseResult.service,
                configurationChanges: [],
                restartRequired: false,
                resources: { platform: 'external', data: { endpoint: 'config-file' } }
              };
              configureResults.push(result);
            }
          }
          break;
        }
        
        case 'list': {
          const baseResult = createBaseResult('configure', 'secrets', 'external', options.environment!, startTime);
          const result: ConfigureResult = {
            ...baseResult,
            entity: baseResult.service,
            configurationChanges: [],
            restartRequired: false,
            resources: { platform: 'external', data: { endpoint: 'secrets-manager' } },
            status: 'listed',
            metadata: {
              action: 'list',
              secrets: Object.keys(KNOWN_SECRETS),
            },
          };
          configureResults.push(result);
          
          if (!isStructuredOutput && options.output === 'summary') {
            console.log(`\n${colors.bright}Available secrets for ${options.environment}:${colors.reset}`);
            for (const [path, description] of Object.entries(KNOWN_SECRETS)) {
              console.log(`  ${colors.cyan}${path}${colors.reset}: ${description}`);
            }
          }
          break;
        }
        
        case 'validate': {
          const config = envConfig!;
          const issues: string[] = [];
          
          // Check required fields
          if (!config.platform?.default) {
            issues.push('Missing platform.default');
          }
          if (config.platform?.default === 'aws' && !config.aws) {
            issues.push('AWS platform requires aws configuration');
          }
          
          const baseResult = createBaseResult('configure', 'validation', 'external', options.environment!, startTime);
          const result: ConfigureResult = {
            ...baseResult,
            entity: baseResult.service,
            configurationChanges: [],
            restartRequired: false,
            resources: { platform: 'external', data: { endpoint: 'config-file' } },
            status: issues.length === 0 ? 'validated' : 'validation-failed',
            success: issues.length === 0, // Override success based on validation
            metadata: {
              action: 'validate',
              issues,
              valid: issues.length === 0,
            },
          };
          configureResults.push(result);
          
          if (!isStructuredOutput && options.output === 'summary') {
            if (issues.length === 0) {
              console.log(`${colors.green}✅ Configuration is valid${colors.reset}`);
            } else {
              console.log(`${colors.red}❌ Configuration issues found:${colors.reset}`);
              for (const issue of issues) {
                console.log(`  - ${issue}`);
              }
            }
          }
          break;
        }
        
        case 'get': {
          if (!options.secretPath) {
            throw new Error('Secret path is required for get action');
          }
          
          try {
            // Use platform-aware secret management
            const value = await getPlatformSecret(options.environment!, options.secretPath!);
            
            const baseResult = createBaseResult('configure', 'secret', 'external', options.environment!, startTime);
            const result: ConfigureResult = {
              ...baseResult,
              entity: baseResult.service,
              configurationChanges: [],
              restartRequired: false,
              resources: { platform: 'external', data: { endpoint: 'secrets-manager', path: options.secretPath } },
              status: value ? 'retrieved' : 'not-found',
              success: value !== null, // Set success based on whether secret was found
              metadata: {
                action: 'get',
                secretPath: options.secretPath,
                value: maskSecretObject(value),
                exists: value !== null,
              },
            };
            configureResults.push(result);
            
            if (!isStructuredOutput && options.output === 'summary') {
              if (value) {
                console.log(`\n${colors.bright}Secret: ${options.secretPath}${colors.reset}`);
                console.log(`Value: ${maskSecretObject(value)}`);
              } else {
                console.log(`${colors.yellow}Secret not found: ${options.secretPath}${colors.reset}`);
              }
            }
          } catch (error: any) {
            const baseResult = createBaseResult('configure', 'secret', 'external', options.environment!, startTime);
            const result: ConfigureResult = {
              ...baseResult,
              entity: baseResult.service,
              configurationChanges: [],
              restartRequired: false,
              resources: { platform: 'external', data: { endpoint: 'secrets-manager', path: options.secretPath } },
              status: 'error',
              success: false,
              error: error.message || 'Failed to get secret',
              metadata: {
                action: 'get',
                secretPath: options.secretPath,
                errorDetails: error.stack,
              },
            };
            configureResults.push(result);
            
            if (!isStructuredOutput && options.output === 'summary') {
              console.log(`${colors.red}Error getting secret: ${error.message}${colors.reset}`);
            }
          }
          break;
        }
        
        case 'set': {
          if (!options.secretPath) {
            throw new Error('Secret path is required for set action');
          }
          
          let newValue: any = options.value;
          
          // If no value provided, prompt for it
          if (!newValue) {
            const rl = createReadlineInterface();
            newValue = await askQuestion(rl, `Enter value for ${options.secretPath}: `);
            rl.close();
          }
          
          // Try to parse as JSON if it looks like JSON
          if (newValue.startsWith('{') || newValue.startsWith('[')) {
            try {
              newValue = JSON.parse(newValue);
            } catch {
              // Keep as string if not valid JSON
            }
          }
          
          if (options.dryRun) {
            // In dry-run mode, use a placeholder secret name
            const secretName = `${options.environment}-${options.secretPath!.replace('/', '-')}-secret`;
            const baseResult = createBaseResult('configure', 'secret', 'external', options.environment!, startTime);
            const result: ConfigureResult = {
              ...baseResult,
              entity: baseResult.service,
              configurationChanges: [{
                key: options.secretPath,
                oldValue: 'masked',
                newValue: maskSecretObject(newValue),
                source: 'aws-secrets-manager',
              }],
              restartRequired: true,
              resources: { platform: 'external', data: { endpoint: 'secrets-manager', path: options.secretPath } },
              status: 'dry-run',
              metadata: {
                action: 'set',
                secretPath: options.secretPath,
                secretName,
                dryRun: true,
              },
            };
            configureResults.push(result);
            
            if (!isStructuredOutput && options.output === 'summary') {
              console.log(`${colors.cyan}[DRY RUN] Would update secret: ${options.secretPath}${colors.reset}`);
            }
          } else {
            // Use platform-aware secret management
            await setPlatformSecret(options.environment!, options.secretPath!, newValue);
            
            const baseResult = createBaseResult('configure', 'secret', 'external', options.environment!, startTime);
            const result: ConfigureResult = {
              ...baseResult,
              entity: baseResult.service,
              configurationChanges: [{
                key: options.secretPath,
                oldValue: 'masked',
                newValue: maskSecretObject(newValue),
                source: 'aws-secrets-manager',
              }],
              restartRequired: true,
              resources: { platform: 'external', data: { endpoint: 'secrets-manager', path: options.secretPath } },
              status: 'updated',
              metadata: {
                action: 'set',
                secretPath: options.secretPath,
                secretName,
              },
            };
            configureResults.push(result);
            
            if (!isStructuredOutput && options.output === 'summary') {
              console.log(`${colors.green}✅ Secret updated: ${options.secretPath}${colors.reset}`);
              console.log(`${colors.yellow}⚠️  Services may need to be restarted to use the new value${colors.reset}`);
            }
          }
          break;
        }
      }
    } catch (error) {
      const baseResult = createBaseResult('configure', 'error', 'external', options.environment!, startTime);
      const errorBaseResult = createErrorResult(baseResult, error as Error);
      const errorResult: ConfigureResult = {
        ...errorBaseResult,
        entity: errorBaseResult.service,
        configurationChanges: [],
        restartRequired: false,
        resources: { platform: 'external', data: { endpoint: 'error' } }
      };
      configureResults.push(errorResult);
      
      if (!isStructuredOutput && options.output === 'summary') {
        console.error(`${colors.red}❌ ${error}${colors.reset}`);
      }
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'configure',
      environment: options.environment!,
      timestamp: new Date(),
      duration: Date.now() - startTime,
      results: configureResults,
      summary: {
        total: configureResults.length,
        succeeded: configureResults.filter(r => r.success).length,
        failed: configureResults.filter(r => !r.success).length,
        warnings: 0,
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: options.dryRun || false,
      }
    };
    
    return commandResults;
    
  } finally {
    // Restore output suppression state
    setSuppressOutput(previousSuppressOutput);
  }
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const configureCommand = new CommandBuilder()
  .name('configure')
  .description('Manage configuration and secrets')
  .schema(ConfigureOptionsSchema)
  .args(withBaseArgs({
    '--secret-path': {
      type: 'string',
      description: 'Secret path (e.g., oauth/google, jwt-secret)',
    },
    '--value': {
      type: 'string',
      description: 'Secret value (will prompt if not provided)',
    },
  }, {
    '-s': '--secret-path',
  }, ['action']))
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont configure -e local show',
    'semiont configure -e production list',
    'semiont configure -e staging validate',
    'semiont configure -e production get oauth/google',
    'semiont configure -e staging set jwt-secret'
  )
  .setupHandler(configure)
  .build();