#!/usr/bin/env node

/**
 * Configure Command V2 - Unified configuration management for Semiont
 * 
 * Manages both public configuration (domains, settings) and private secrets (OAuth, JWT)
 * 
 * Usage:
 *   semiont configure show                       # Show public configuration
 *   semiont configure list                       # List all configurable items  
 *   semiont configure validate                   # Validate configuration
 *   semiont configure -e production get oauth/google    # Get secret
 *   semiont configure -e staging set oauth/google       # Set secret
 */

import { z } from 'zod';
import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SemiontStackConfig } from './lib/stack-config';
import { loadEnvironmentConfig, displayConfiguration, ConfigurationError } from '@semiont/config-loader';
import * as readline from 'readline';
import { getAvailableEnvironments } from './lib/environment-discovery';

// =====================================================================
// ARGUMENT PARSING WITH ZOD
// =====================================================================

const ConfigureOptionsSchema = z.object({
  command: z.enum(['show', 'list', 'validate', 'get', 'set']),
  environment: z.string().optional(), // Required for get/set operations
  secretPath: z.string().optional(),  // Required for get/set operations  
  value: z.string().optional(),       // Optional for set operations
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
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
      command: command as 'show' | 'list' | 'validate' | 'get' | 'set',
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
  console.log('📋 Semiont Configuration Overview\n');
  
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
  console.log('📋 Configurable Items\n');
  
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
  console.log('✅ Validating Semiont configuration...\n');
  
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
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  try {
    const options = parseArgs();
    
    if (options.verbose) {
      console.log('🔧 Configure options:', options);
    }
    
    switch (options.command) {
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
        await getSecret(options);
        break;
        
      case 'set':
        await setSecret(options);
        break;
        
      default:
        console.error(`❌ Unknown command: ${options.command}`);
        process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Configure failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}