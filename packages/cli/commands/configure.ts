/**
 * Configure Command - Unified configuration management with structured output
 * 
 * Manages both public configuration (domains, settings) and private secrets (OAuth, JWT)
 * Now supports structured output for programmatic access.
 */

import { z } from 'zod';
import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SemiontStackConfig } from '../lib/stack-config.js';
import { loadEnvironmentConfig, displayConfiguration, getAvailableEnvironments, ConfigurationError } from '../lib/deployment-resolver.js';
import * as readline from 'readline';
import { colors } from '../lib/cli-colors.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { 
  ConfigureResult, 
  CommandResults, 
  createBaseResult,
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';
import { CommandFunction, BaseCommandOptions } from '../lib/command-types.js';

// =====================================================================
// ARGUMENT PARSING WITH ZOD
// =====================================================================

const ConfigureOptionsSchema = z.object({
  action: z.enum(['show', 'list', 'validate', 'get', 'set']).default('show'),
  environment: z.string().default('local'),
  secretPath: z.string().optional(),
  value: z.string().optional(),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).default('summary'),
});

interface ConfigureOptions extends BaseCommandOptions {
  action: 'show' | 'list' | 'validate' | 'get' | 'set';
  secretPath?: string;
  value?: string;
}

// =====================================================================
// CONSTANTS
// =====================================================================

// Known secrets and their descriptions
const KNOWN_SECRETS: Record<string, string> = {
  'oauth/google': 'Google OAuth client ID and secret',
  'oauth/github': 'GitHub OAuth client ID and secret', 
  'jwt-secret': 'JWT signing secret for API authentication',
  'app-secrets': 'Application secrets (session, NextAuth, etc.)'
};

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

// Global flag to control output suppression
let suppressOutput = false;

function printError(message: string): string {
  const msg = `${colors.red}❌ ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.error(msg);
  }
  return msg;
}

function printSuccess(message: string): string {
  const msg = `${colors.green}✅ ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.log(msg);
  }
  return msg;
}

function printInfo(message: string): string {
  const msg = `${colors.cyan}ℹ️  ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.log(msg);
  }
  return msg;
}

function printWarning(message: string): string {
  const msg = `${colors.yellow}⚠️  ${message}${colors.reset}`;
  if (!suppressOutput) {
    console.log(msg);
  }
  return msg;
}

function printDebug(message: string, options: ConfigureOptions): string {
  const msg = `${colors.dim}[DEBUG] ${message}${colors.reset}`;
  if (!suppressOutput && options.verbose) {
    console.log(msg);
  }
  return msg;
}

// Note: Argument parsing is now handled by cli.ts

// Note: Help is now handled by cli.ts

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

async function getCurrentSecret(environment: string, secretName: string): Promise<any> {
  const envConfig = loadEnvironmentConfig(environment);
  
  if (!envConfig.aws) {
    throw new Error(`Environment ${environment} does not have AWS configuration`);
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

async function updateSecret(environment: string, secretName: string, secretValue: any): Promise<void> {
  const envConfig = loadEnvironmentConfig(environment);
  
  if (!envConfig.aws) {
    throw new Error(`Environment ${environment} does not have AWS configuration`);
  }
  
  const secretsClient = new SecretsManagerClient({ region: envConfig.aws.region });
  const secretString = typeof secretValue === 'string' ? secretValue : JSON.stringify(secretValue);
  
  await secretsClient.send(
    new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: secretString,
    })
  );
}

// Note: Command implementations are now handled within the structured configure function

// =====================================================================
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

// Type assertion to ensure this function matches the CommandFunction signature
export const configure: CommandFunction<ConfigureOptions> = async (
  serviceDeployments: ServiceDeploymentInfo[], // Not used but kept for API consistency
  options: ConfigureOptions
): Promise<CommandResults> => {
  const startTime = Date.now();
  const isStructuredOutput = options.output && ['json', 'yaml', 'table'].includes(options.output);
  
  // Suppress output for structured formats
  const previousSuppressOutput = suppressOutput;
  suppressOutput = isStructuredOutput;
  
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
            } catch (error) {
              const errorResult = createErrorResult(
                createBaseResult('configure', 'configuration', 'external', env, startTime),
                error as Error
              ) as ConfigureResult;
              errorResult.configurationChanges = [];
              errorResult.restartRequired = false;
              errorResult.resourceId = { external: {} };
              errorResult.status = 'failed';
              errorResult.metadata = { action: 'show', error: (error as Error).message };
              configureResults.push(errorResult);
            }
          }
          break;
        }
        
        case 'list': {
          const result: ConfigureResult = {
            ...createBaseResult('configure', 'secrets', 'external', options.environment, startTime),
            configurationChanges: [],
            restartRequired: false,
            resourceId: { external: { endpoint: 'secrets-list' } },
            status: 'listed',
            metadata: {
              action: 'list',
              availableSecrets: Object.keys(KNOWN_SECRETS),
              secretDescriptions: KNOWN_SECRETS,
            },
          };
          configureResults.push(result);
          break;
        }
        
        case 'validate': {
          const environments = getAvailableEnvironments();
          let validationErrors = 0;
          
          for (const env of environments) {
            try {
              const config = loadEnvironmentConfig(env);
              const issues: string[] = [];
              
              if (!config.services) {
                issues.push('No services defined');
              }
              
              if (config.deployment?.default === 'aws' && !config.aws) {
                issues.push('AWS deployment specified but no AWS configuration');
                validationErrors++;
              }
              
              const result: ConfigureResult = {
                ...createBaseResult('configure', 'validation', 'external', env, startTime),
                configurationChanges: [],
                restartRequired: false,
                resourceId: { external: { endpoint: 'validation' } },
                status: issues.length === 0 ? 'valid' : 'invalid',
                success: issues.length === 0,
                metadata: {
                  action: 'validate',
                  issues,
                  servicesCount: Object.keys(config.services || {}).length,
                  hasAwsConfig: !!config.aws,
                },
              };
              configureResults.push(result);
            } catch (error) {
              validationErrors++;
              const errorResult = createErrorResult(
                createBaseResult('configure', 'validation', 'external', env, startTime),
                error as Error
              ) as ConfigureResult;
              errorResult.configurationChanges = [];
              errorResult.restartRequired = false;
              errorResult.resourceId = { external: {} };
              errorResult.status = 'failed';
              errorResult.metadata = { action: 'validate', error: (error as Error).message };
              configureResults.push(errorResult);
            }
          }
          break;
        }
        
        case 'get': {
          if (!options.secretPath) {
            throw new Error('Secret path is required for get operation');
          }
          
          const fullName = await getSecretFullName(options.environment, options.secretPath);
          const secret = await getCurrentSecret(options.environment, fullName);
          
          const result: ConfigureResult = {
            ...createBaseResult('configure', options.secretPath, 'aws', options.environment, startTime),
            configurationChanges: [],
            restartRequired: false,
            resourceId: { aws: { name: fullName } },
            status: secret ? 'retrieved' : 'not-found',
            success: !!secret,
            metadata: {
              action: 'get',
              secretPath: options.secretPath,
              exists: !!secret,
              type: typeof secret,
              masked: secret ? maskSecretObject(secret) : null,
            },
          };
          configureResults.push(result);
          break;
        }
        
        case 'set': {
          if (!options.secretPath) {
            throw new Error('Secret path is required for set operation');
          }
          
          const fullName = await getSecretFullName(options.environment, options.secretPath);
          let currentSecret;
          try {
            currentSecret = await getCurrentSecret(options.environment, fullName);
          } catch {
            currentSecret = null;
          }
          
          let newValue = options.value;
          if (!newValue && !options.dryRun && !isStructuredOutput) {
            // Interactive prompt for value
            const rl = createReadlineInterface();
            
            if (KNOWN_SECRETS[options.secretPath]?.includes('OAuth')) {
              const clientId = await askQuestion(rl, 'Client ID: ');
              const clientSecret = await askQuestion(rl, 'Client Secret: ');
              newValue = JSON.stringify({ clientId, clientSecret });
            } else {
              newValue = await askQuestion(rl, 'Enter secret value: ');
            }
            rl.close();
          }
          
          if (!options.dryRun && newValue) {
            await updateSecret(options.environment, fullName, newValue);
          }
          
          const result: ConfigureResult = {
            ...createBaseResult('configure', options.secretPath, 'aws', options.environment, startTime),
            configurationChanges: [
              {
                key: options.secretPath,
                oldValue: currentSecret ? maskSecretObject(currentSecret) : undefined,
                newValue: newValue ? maskSecretObject(newValue) : undefined,
                source: 'aws-secrets-manager',
              },
            ],
            restartRequired: true,
            resourceId: { aws: { name: fullName } },
            status: options.dryRun ? 'dry-run' : 'updated',
            metadata: {
              action: 'set',
              secretPath: options.secretPath,
              wasExisting: !!currentSecret,
              dryRun: options.dryRun,
            },
          };
          configureResults.push(result);
          break;
        }
      }
    } catch (error) {
      const errorResult = createErrorResult(
        createBaseResult('configure', options.action, 'external', options.environment, startTime),
        error as Error
      ) as ConfigureResult;
      errorResult.configurationChanges = [];
      errorResult.restartRequired = false;
      errorResult.resourceId = { external: {} };
      errorResult.status = 'failed';
      errorResult.metadata = { action: options.action, error: (error as Error).message };
      configureResults.push(errorResult);
    }
    
    // Create aggregated results
    const commandResults: CommandResults = {
      command: 'configure',
      environment: options.environment,
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
        dryRun: options.dryRun,
      }
    };
    
    return commandResults;
    
  } finally {
    // Restore output suppression state
    suppressOutput = previousSuppressOutput;
  }
};

// Note: The main function is removed as cli.ts now handles service resolution and output formatting
// The configure function now accepts pre-resolved services and returns CommandResults

export { ConfigureOptions, ConfigureOptionsSchema };