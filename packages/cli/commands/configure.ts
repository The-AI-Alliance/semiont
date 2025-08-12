/**
 * Configure Command V2 - Unified configuration management with structured output
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
import { resolveServiceSelector, validateServiceSelector } from '../lib/services.js';
import { resolveServiceDeployments, type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';
import { 
  ConfigureResult, 
  CommandResults, 
  createBaseResult,
  createErrorResult,
  ResourceIdentifier 
} from '../lib/command-results.js';

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

type ConfigureOptions = z.infer<typeof ConfigureOptionsSchema>;

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

function printError(message: string): void {
  if (!suppressOutput) {
    console.error(`${colors.red}❌ ${message}${colors.reset}`);
  }
}

function printSuccess(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
  }
}

function printInfo(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
  }
}

function printWarning(message: string): void {
  if (!suppressOutput) {
    console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
  }
}

function printDebug(message: string, options: ConfigureOptions): void {
  if (!suppressOutput && options.verbose) {
    console.log(`${colors.dim}[DEBUG] ${message}${colors.reset}`);
  }
}

// =====================================================================
// ARGUMENT PARSING
// =====================================================================

function parseArgs(): ConfigureOptions {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Parse command (first non-flag argument)
  let command: string | undefined;
  let environment: string | undefined;  
  let secretPath: string | undefined;
  let value: string | undefined;
  let verbose = false;
  let dryRun = false;

  // Extract flags
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--environment' || arg === '-e') {
      environment = args[i + 1];
      i++; // Skip next arg
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('-')) {
      // Non-flag arguments in order: command, secretPath, value
      if (!command) {
        command = arg;
      } else if (!secretPath) {
        secretPath = arg;
      } else if (!value) {
        value = arg;
      }
    }
  }

  if (!command) {
    console.error('❌ Command is required');
    printHelp();
    process.exit(1);
  }

  // Validate command
  if (!['show', 'list', 'validate', 'get', 'set'].includes(command)) {
    console.error(`❌ Invalid command: ${command}`);
    printHelp();
    process.exit(1);
  }

  // Environment is required for get/set operations
  if (['get', 'set'].includes(command) && !environment) {
    console.error(`❌ --environment is required for '${command}' operations`);
    console.log(`💡 Available environments: ${getAvailableEnvironments().join(', ')}`);
    process.exit(1);
  }

  // Secret path is required for get/set operations
  if (['get', 'set'].includes(command) && !secretPath) {
    console.error(`❌ Secret path is required for '${command}' operations`);
    console.log(`💡 Available secrets: ${Object.keys(KNOWN_SECRETS).join(', ')}`);
    process.exit(1);
  }

  try {
    return ConfigureOptionsSchema.parse({
      action: command as 'show' | 'list' | 'validate' | 'get' | 'set',
      environment,
      secretPath,
      value,
      verbose,
      dryRun,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

function printHelp(): void {
  console.log(`
🔧 Semiont Configure Command

Usage:
  semiont configure <command> [options]

Commands:
  show           Show public configuration for all environments
  list           List all configurable items and secrets
  validate       Validate configuration files
  get <secret>   Get a secret value from AWS Secrets Manager
  set <secret>   Set a secret value in AWS Secrets Manager

Options:
  -e, --environment <env>    Environment (required for get/set)
  -v, --verbose             Show detailed output
  --dry-run                 Show what would be done without making changes
  -h, --help                Show this help message

Examples:
  # Configuration management
  semiont configure show                       # Show all environment configs
  semiont configure list                       # List available secrets
  semiont configure validate                   # Validate config files
  
  # Secret management (requires environment)  
  semiont configure -e production get oauth/google    # Get OAuth secrets
  semiont configure -e staging set oauth/google       # Set OAuth secrets
  semiont configure -e production get jwt-secret      # Get JWT secret

Available Secrets:
${Object.entries(KNOWN_SECRETS).map(([key, desc]) => `  ${key.padEnd(15)} ${desc}`).join('\n')}

Requirements:
  • AWS CLI configured for secret operations
  • Valid environment configuration
  • Appropriate IAM permissions for Secrets Manager
`);
}

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
    return JSON.parse(response.SecretString || '{}');
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

// =====================================================================
// COMMAND IMPLEMENTATIONS
// =====================================================================

async function showConfiguration(): Promise<void> {
  printInfo('📋 Semiont Configuration Overview\n');
  
  const environments = getAvailableEnvironments();
  for (const env of environments) {
    try {
      console.log(`\n🌟 Environment: ${env}`);
      console.log('─'.repeat(50));
      
      const config = loadEnvironmentConfig(env);
      
      // Show key configuration sections
      console.log(`Domain: ${config.site?.domain || 'Not configured'}`);
      console.log(`Deployment: ${config.deployment?.default || 'Not specified'}`);
      
      if (config.services) {
        console.log('Services:');
        for (const [serviceName, serviceConfig] of Object.entries(config.services)) {
          const service = serviceConfig as any;
          const deployType = service.deployment?.type || config.deployment?.default;
          console.log(`  • ${serviceName}: ${deployType}`);
        }
      }
      
      if (config.aws) {
        console.log(`AWS Region: ${config.aws.region}`);
        console.log(`AWS Account: ${config.aws.accountId || 'Not specified'}`);
      }
      
    } catch (error) {
      console.error(`❌ Failed to load ${env}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  console.log('\n💡 Use "semiont configure list" to see configurable secrets');
}

async function listConfigurable(): Promise<void> {
  printInfo('📋 Configurable Items\n');
  
  console.log('🔐 Available Secrets:');
  for (const [path, description] of Object.entries(KNOWN_SECRETS)) {
    console.log(`  • ${path.padEnd(15)} - ${description}`);
  }
  
  console.log('\n📝 Public Configuration:');
  console.log('  • Environment files in config/environments/');
  console.log('  • Service deployment types (container, aws)');  
  console.log('  • Site settings (domain, email, OAuth domains)');
  console.log('  • App features and security settings');
  
  console.log('\n💡 Usage:');
  console.log('  semiont configure show                    # View current config');
  console.log('  semiont configure -e prod get oauth/google   # Get secrets');
  console.log('  semiont configure -e prod set jwt-secret     # Set secrets');
}

async function validateConfiguration(): Promise<void> {
  printInfo('✅ Validating Semiont configuration...\n');
  
  const environments = getAvailableEnvironments();
  let errors = 0;
  
  for (const env of environments) {
    try {
      console.log(`🔍 Validating ${env}...`);
      const config = loadEnvironmentConfig(env);
      
      // Basic validation checks
      if (!config.services) {
        console.log(`  ⚠️  No services defined`);
      } else {
        console.log(`  ✅ ${Object.keys(config.services).length} services defined`);
      }
      
      if (config.deployment?.default === 'aws' && !config.aws) {
        console.log(`  ❌ AWS deployment specified but no AWS configuration`);
        errors++;
      } else if (config.aws) {
        console.log(`  ✅ AWS configuration present`);
      }
      
    } catch (error) {
      console.error(`  ❌ Failed to load: ${error instanceof Error ? error.message : String(error)}`);
      errors++;
    }
  }
  
  console.log('');
  if (errors === 0) {
    console.log('✅ Configuration validation passed');
  } else {
    console.error(`❌ Configuration validation failed with ${errors} error(s)`);
    process.exit(1);
  }
}

async function getSecret(options: ConfigureOptions): Promise<void> {
  const { environment, secretPath, verbose } = options;
  
  if (!environment || !secretPath) {
    throw new Error('Environment and secret path are required');
  }
  
  console.log(`🔍 Reading secret: ${secretPath} from ${environment}\n`);
  
  if (verbose) {
    console.log(`Environment: ${environment}`);
    console.log(`Secret path: ${secretPath}`);
  }
  
  try {
    const fullName = await getSecretFullName(environment, secretPath);
    if (verbose) {
      console.log(`Full secret name: ${fullName}`);
    }
    
    const secret = await getCurrentSecret(environment, fullName);
    
    if (secret === null) {
      console.log(`❌ Secret '${secretPath}' not found`);
      console.log(`   Full name: ${fullName}`);
      console.log('\n💡 Available secrets:');
      for (const key of Object.keys(KNOWN_SECRETS)) {
        console.log(`   • ${key}`);
      }
      return;
    }
    
    console.log(`✅ Secret: ${secretPath}`);
    
    if (typeof secret === 'string') {
      console.log(`Value: ${maskSecret(secret)}`);
    } else {
      const masked = maskSecretObject(secret);
      console.log('Value:');
      console.log(JSON.stringify(masked, null, 2));
    }
    
  } catch (error) {
    console.error(`❌ Failed to get secret: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function setSecret(options: ConfigureOptions): Promise<void> {
  const { environment, secretPath, value, verbose, dryRun } = options;
  
  if (!environment || !secretPath) {
    throw new Error('Environment and secret path are required');
  }
  
  console.log(`🔐 Setting secret: ${secretPath} in ${environment}\n`);
  
  try {
    const fullName = await getSecretFullName(environment, secretPath);
    if (verbose) {
      console.log(`Full secret name: ${fullName}`);
    }
    
    // Get current secret to show what we're updating
    let currentSecret;
    try {
      currentSecret = await getCurrentSecret(environment, fullName);
    } catch (error) {
      // Secret might not exist yet, that's okay
      currentSecret = null;
    }
    
    if (currentSecret) {
      console.log('📋 Current value:');
      if (typeof currentSecret === 'string') {
        console.log(`  ${maskSecret(currentSecret)}`);
      } else {
        const masked = maskSecretObject(currentSecret);
        console.log(JSON.stringify(masked, null, 2));
      }
    } else {
      console.log('📋 Secret does not exist yet - will be created');
    }
    
    let newValue: string;
    
    if (value) {
      // Value provided as argument
      newValue = value;
    } else {
      // Prompt for value
      const rl = createReadlineInterface();
      
      if (KNOWN_SECRETS[secretPath]?.includes('OAuth')) {
        console.log('\n🔑 OAuth Configuration:');
        const clientId = await askQuestion(rl, 'Client ID: ');
        const clientSecret = await askQuestion(rl, 'Client Secret: ');
        
        newValue = JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim()
        });
      } else {
        newValue = await askQuestion(rl, '\nEnter secret value: ');
      }
      
      rl.close();
    }
    
    if (dryRun) {
      console.log('\n🔍 DRY RUN - Would set secret to:');
      if (newValue.startsWith('{')) {
        // JSON secret
        try {
          const parsed = JSON.parse(newValue);
          const masked = maskSecretObject(parsed);
          console.log(JSON.stringify(masked, null, 2));
        } catch {
          console.log(maskSecret(newValue));
        }
      } else {
        console.log(maskSecret(newValue));
      }
      return;
    }
    
    console.log('\n💾 Updating secret...');
    await updateSecret(environment, fullName, newValue);
    console.log('✅ Secret updated successfully');
    
  } catch (error) {
    console.error(`❌ Failed to set secret: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// =====================================================================
// STRUCTURED OUTPUT FUNCTION
// =====================================================================

export async function configure(options: ConfigureOptions): Promise<CommandResults> {
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
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

export async function main(options?: ConfigureOptions): Promise<void> {
  try {
    const opts = options || parseArgs();
    
    const results = await configure(opts);
    
    // Handle structured output
    if (opts.output !== 'summary') {
      const { formatResults } = await import('../lib/output-formatter.js');
      const formatted = formatResults(results, opts.output);
      console.log(formatted);
      return;
    }
    
    // For summary format, show human-readable output
    if (opts.verbose) {
      printDebug(`Configure options: ${JSON.stringify(opts)}`, opts);
    }
    
    switch (opts.action) {
      case 'show':
        await showConfiguration();
        break;
        
      case 'list':
        await listConfigurable();
        break;
        
      case 'validate':
        await validateConfiguration();
        break;
        
      case 'get':
        await getSecret(opts);
        break;
        
      case 'set':
        await setSecret(opts);
        break;
        
      default:
        printError(`Unknown action: ${opts.action}`);
        process.exit(1);
    }
    
    // Exit with appropriate code
    if (results.summary && results.summary.failed > 0) {
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Configure failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    printError(`Unexpected error: ${error}`);
    process.exit(1);
  });
}

export { ConfigureOptions, ConfigureOptionsSchema };