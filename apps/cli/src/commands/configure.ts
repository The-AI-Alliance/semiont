/**
 * Configure Command - Unified configuration management (v2)
 * 
 * Manages both public configuration (domains, settings) and private secrets (OAuth, JWT)
 * Migrated to use the new command definition structure.
 */

import { z } from 'zod';
import { colors } from '../lib/cli-colors.js';
import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SemiontStackConfig } from '../lib/stack-config.js';
import { loadEnvironmentConfig, getAvailableEnvironments } from '../lib/deployment-resolver.js';
import { type EnvironmentConfig, hasAWSConfig } from '../lib/environment-config.js';
import * as readline from 'readline';
import { printInfo, setSuppressOutput } from '../lib/cli-logger.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { 
  ConfigureResult, 
  CommandResults, 
  createBaseResult,
  createErrorResult 
} from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { BaseOptionsSchema } from '../lib/base-options-schema.js';

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

async function getSecretFullName(environment: string, secretPath: string): Promise<string> {
  // Convert path format to actual secret name
  // oauth/google -> semiont-production-oauth-google-secret (or similar based on stack config)
  const stackConfig = new SemiontStackConfig(environment);
  const config = await stackConfig.getConfig();
  const stackName = config.infraStack.name;
  return `${stackName}-${secretPath.replace('/', '-')}-secret`;
}

async function getCurrentSecret(envConfig: EnvironmentConfig, secretName: string): Promise<any> {
  if (!hasAWSConfig(envConfig)) {
    throw new Error(`Environment configuration does not have AWS settings`);
  }
  
  const secretsClient = new SecretsManagerClient({ region: envConfig.aws.region });
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretName,
      })
    );
    // Try to parse as JSON, but if it fails, return as string
    try {
      return JSON.parse(response.SecretString || '{}');
    } catch {
      return response.SecretString || null;
    }
  } catch (error: any) {
    if (error.name === 'ResourceNotFoundException') {
      return null;
    }
    throw error;
  }
}

async function updateSecret(envConfig: EnvironmentConfig, secretName: string, secretValue: any): Promise<void> {
  if (!hasAWSConfig(envConfig)) {
    throw new Error(`Environment configuration does not have AWS settings`);
  }
  
  const secretsClient = new SecretsManagerClient({ region: envConfig.aws.region });
  const secretString = typeof secretValue === 'string' ? secretValue : JSON.stringify(secretValue);
  
  // First, try to update the existing secret
  try {
    await secretsClient.send(
      new UpdateSecretCommand({
        SecretId: secretName,
        SecretString: secretString,
      })
    );
  } catch (error: any) {
    // If the secret doesn't exist, create it
    if (error.name === 'ResourceNotFoundException') {
      await secretsClient.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: secretString,
          Description: `Created by semiont configure command`,
        })
      );
    } else {
      throw error;
    }
  }
}

// =====================================================================
// COMMAND IMPLEMENTATION
// =====================================================================

async function configure(
  _serviceDeployments: ServiceDeploymentInfo[], // Not used but kept for API consistency
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
              const result: ConfigureResult = {
                ...createBaseResult('configure', 'configuration', 'external', env, startTime),
                configurationChanges: [],
                restartRequired: false,
                resourceId: { external: { endpoint: 'config-file' } },
                status: 'shown',
                metadata: {
                  action: 'show',
                  domain: config.site?.domain || 'Not configured',
                  deployment: config.deployment?.default || 'Not specified',
                  services: Object.keys(config.services || {}),
                  awsRegion: config.aws?.region,
                },
              };
              configureResults.push(result);
              
              if (!isStructuredOutput && options.output === 'summary') {
                console.log(`\n${colors.bright}${env}:${colors.reset}`);
                console.log(`  Domain: ${config.site?.domain || 'Not configured'}`);
                console.log(`  Default deployment: ${config.deployment?.default || 'Not specified'}`);
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
              
              const result = createErrorResult(
                createBaseResult('configure', 'configuration', 'external', env, startTime),
                error as Error
              ) as ConfigureResult;
              result.configurationChanges = [];
              result.restartRequired = false;
              result.resourceId = { external: { endpoint: 'config-file' } };
              configureResults.push(result);
            }
          }
          break;
        }
        
        case 'list': {
          const result: ConfigureResult = {
            ...createBaseResult('configure', 'secrets', 'external', options.environment!, startTime),
            configurationChanges: [],
            restartRequired: false,
            resourceId: { external: { endpoint: 'secrets-manager' } },
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
          if (!config.deployment?.default) {
            issues.push('Missing deployment.default');
          }
          if (config.deployment?.default === 'aws' && !config.aws) {
            issues.push('AWS deployment requires aws configuration');
          }
          
          const result: ConfigureResult = {
            ...createBaseResult('configure', 'validation', 'external', options.environment!, startTime),
            configurationChanges: [],
            restartRequired: false,
            resourceId: { external: { endpoint: 'config-file' } },
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
          
          const secretName = await getSecretFullName(options.environment!, options.secretPath!);
          const value = await getCurrentSecret(envConfig!, secretName);
          
          const result: ConfigureResult = {
            ...createBaseResult('configure', 'secret', 'external', options.environment!, startTime),
            configurationChanges: [],
            restartRequired: false,
            resourceId: { external: { endpoint: 'secrets-manager', path: options.secretPath } },
            status: value ? 'retrieved' : 'not-found',
            success: value !== null, // Set success based on whether secret was found
            metadata: {
              action: 'get',
              secretPath: options.secretPath,
              secretName,
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
          break;
        }
        
        case 'set': {
          if (!options.secretPath) {
            throw new Error('Secret path is required for set action');
          }
          
          const secretName = await getSecretFullName(options.environment!, options.secretPath!);
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
            const result: ConfigureResult = {
              ...createBaseResult('configure', 'secret', 'external', options.environment!, startTime),
              configurationChanges: [{
                key: options.secretPath,
                oldValue: 'masked',
                newValue: maskSecretObject(newValue),
                source: 'aws-secrets-manager',
              }],
              restartRequired: true,
              resourceId: { external: { endpoint: 'secrets-manager', path: options.secretPath } },
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
            await updateSecret(envConfig!, secretName, newValue);
            
            const result: ConfigureResult = {
              ...createBaseResult('configure', 'secret', 'external', options.environment!, startTime),
              configurationChanges: [{
                key: options.secretPath,
                oldValue: 'masked',
                newValue: maskSecretObject(newValue),
                source: 'aws-secrets-manager',
              }],
              restartRequired: true,
              resourceId: { external: { endpoint: 'secrets-manager', path: options.secretPath } },
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
      const errorResult = createErrorResult(baseResult, error as Error) as ConfigureResult;
      errorResult.configurationChanges = [];
      errorResult.restartRequired = false;
      errorResult.resourceId = { external: { endpoint: 'error' } };
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
      services: configureResults,
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

export const configureCommand = new CommandBuilder<ConfigureOptions>()
  .name('configure')
  .description('Manage configuration and secrets')
  .schema(ConfigureOptionsSchema)
  .args({
    args: {
      '--environment': {
        type: 'string',
        description: 'Target environment',
        required: true,
      },
      '--secret-path': {
        type: 'string',
        description: 'Secret path (e.g., oauth/google, jwt-secret)',
      },
      '--value': {
        type: 'string',
        description: 'Secret value (will prompt if not provided)',
      },
      '--output': {
        type: 'string',
        description: 'Output format',
        choices: ['summary', 'table', 'json', 'yaml'],
        default: 'summary',
      },
      '--verbose': {
        type: 'boolean',
        description: 'Verbose output',
        default: false,
      },
      '--dry-run': {
        type: 'boolean',
        description: 'Preview changes without applying',
        default: false,
      },
    },
    aliases: {
      '-e': '--environment',
      '-s': '--secret-path',
      '-o': '--output',
      '-v': '--verbose',
    },
    positional: ['action'], // First positional arg is the action
  })
  .requiresEnvironment(true)
  .requiresServices(false)
  .examples(
    'semiont configure -e local show',
    'semiont configure -e production list',
    'semiont configure -e staging validate',
    'semiont configure -e production get oauth/google',
    'semiont configure -e staging set jwt-secret'
  )
  .handler(configure)
  .build();

// Also export as default for compatibility
export default configureCommand;