#!/usr/bin/env -S npx tsx

/**
 * Configure Command - Unified configuration management for Semiont
 * 
 * Manages both public configuration (domains, settings) and private secrets (OAuth, JWT)
 * 
 * Usage:
 *   ./scripts/semiont configure show            # Show public configuration
 *   ./scripts/semiont configure list            # List all configurable items
 *   ./scripts/semiont configure oauth/google    # Set OAuth secrets
 *   ./scripts/semiont configure jwt-secret      # Set JWT secret
 */

import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { SemiontStackConfig } from './lib/stack-config';
import { loadConfig, displayConfiguration, ConfigurationError } from '../config/dist/index.js';
import * as readline from 'readline';

// Reserved for future secret management features
// interface SecretInfo for future use when needed

// Known secrets and their descriptions
const KNOWN_SECRETS: Record<string, string> = {
  'oauth/google': 'Google OAuth client ID and secret',
  'oauth/github': 'GitHub OAuth client ID and secret', 
  'jwt-secret': 'JWT signing secret for API authentication',
  'app-secrets': 'Application secrets (session, NextAuth, etc.)'
};

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
  const envConfig = loadConfig(environment);
  const stackConfig = new SemiontStackConfig(envConfig.aws.region);
  const config = await stackConfig.getConfig();
  const stackName = config.infraStack.name;
  return `${stackName}-${secretPath.replace('/', '-')}-secret`;
}

async function getCurrentSecret(environment: string, secretName: string): Promise<any> {
  const envConfig = loadConfig(environment);
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
  const envConfig = loadConfig(environment);
  const secretsClient = new SecretsManagerClient({ region: envConfig.aws.region });
  const secretString = typeof secretValue === 'string' ? secretValue : JSON.stringify(secretValue);
  
  await secretsClient.send(
    new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: secretString,
    })
  );
}

// Remove unused listSecrets function for now - can be reimplemented later with environment support

async function getSecret(environment: string, secretPath: string): Promise<void> {
  console.log(`🔍 Reading secret: ${secretPath} from ${environment}\n`);
  
  const fullName = await getSecretFullName(environment, secretPath);
  const secret = await getCurrentSecret(environment, fullName);
  
  if (secret === null) {
    console.log(`❌ Secret '${secretPath}' not found`);
    console.log(`   Full name: ${fullName}`);
    return;
  }
  
  console.log(`Secret: ${secretPath}`);
  
  if (typeof secret === 'string') {
    console.log(`Value: ${maskSecret(secret)}`);
  } else {
    const masked = maskSecretObject(secret);
    console.log('Value:');
    console.log(JSON.stringify(masked, null, 2));
  }
}

async function setSecret(environment: string, secretPath: string, value?: string): Promise<void> {
  console.log(`🔐 Setting secret: ${secretPath} in ${environment}\n`);
  
  const fullName = await getSecretFullName(environment, secretPath);
  let secretValue: any;
  
  if (value) {
    // Value provided as argument
    try {
      // Try to parse as JSON first
      secretValue = JSON.parse(value);
    } catch {
      // If not JSON, treat as string
      secretValue = value;
    }
  } else {
    // Interactive mode
    const rl = createReadlineInterface();
    
    try {
      if (secretPath === 'oauth/google') {
        console.log('Setting up Google OAuth credentials...\n');
        const clientId = await askQuestion(rl, 'Enter Google Client ID: ');
        const clientSecret = await askQuestion(rl, 'Enter Google Client Secret: ');
        
        if (!clientId || !clientSecret) {
          console.log('❌ Both Client ID and Client Secret are required');
          return;
        }
        
        secretValue = {
          clientId,
          clientSecret
        };
      } else if (secretPath === 'oauth/github') {
        console.log('Setting up GitHub OAuth credentials...\n');
        const clientId = await askQuestion(rl, 'Enter GitHub Client ID: ');
        const clientSecret = await askQuestion(rl, 'Enter GitHub Client Secret: ');
        
        if (!clientId || !clientSecret) {
          console.log('❌ Both Client ID and Client Secret are required');
          return;
        }
        
        secretValue = {
          clientId,
          clientSecret
        };
      } else {
        // Generic secret
        const input = await askQuestion(rl, `Enter value for '${secretPath}': `);
        if (!input) {
          console.log('❌ Value cannot be empty');
          return;
        }
        
        try {
          secretValue = JSON.parse(input);
        } catch {
          secretValue = input;
        }
      }
    } finally {
      rl.close();
    }
  }
  
  try {
    await updateSecret(environment, fullName, secretValue);
    console.log(`✅ Secret '${secretPath}' updated successfully`);
    console.log(`   Full name: ${fullName}`);
    
    if (secretPath.startsWith('oauth/')) {
      console.log('\n💡 Next steps:');
      console.log('   1. Deploy configuration: ./scripts/semiont deploy app');  
      console.log('   2. Restart services: ./scripts/semiont restart');
      console.log('   3. Test OAuth flow in your application');
    }
  } catch (error: any) {
    console.error(`❌ Failed to update secret '${secretPath}':`, error.message);
    process.exit(1);
  }
}

function showConfiguration(): void {
  try {
    console.log('\n📋 Current Semiont Configuration:\n');
    displayConfiguration();
    console.log('\n✅ Configuration is valid\n');
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(`❌ Configuration validation failed: ${error.message}`);
      if (error.field) {
        console.error(`   Field: ${error.field}`);
      }
    } else {
      console.error(`❌ Failed to load configuration:`, error);
    }
    process.exit(1);
  }
}

function showHelp(): void {
  console.log('🔧 Semiont Configuration Manager\n');
  console.log('Usage: semiont configure <command> [args...]\n');
  console.log('Commands:');
  console.log('   show                          - Show current public configuration');
  console.log('   list                          - List all configurable items');
  console.log('   <env> get <secret-path>       - Read a private secret (masked)');
  console.log('   <env> set <secret-path> [val] - Set a private secret\n');
  console.log('Examples:');
  console.log('   semiont configure show');
  console.log('   semiont configure list');
  console.log('   semiont configure production get oauth/google');
  console.log('   semiont configure staging set oauth/google');
  console.log('   semiont configure production set jwt-secret "my-secret-32-chars"');
}

async function listConfigurable(): Promise<void> {
  console.log('📋 Configurable Items:\n');
  
  console.log('🔧 Public Configuration (edit config/environments/*.ts):');
  console.log('   • Domain and site settings');
  console.log('   • Feature flags and application settings');
  console.log('   • AWS infrastructure configuration');
  console.log('   • Use: ./scripts/semiont configure show\n');
  
  console.log('🔐 Private Secrets (managed securely):');
  for (const [secretPath, description] of Object.entries(KNOWN_SECRETS)) {
    console.log(`   • ${secretPath.padEnd(20)} - ${description}`);
  }
  console.log('   • Use: ./scripts/semiont configure <environment> <get|set> <secret-path>\n');
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    // Show help
    showHelp();
    return;
  }
  
  const firstArg = args[0];
  
  // Handle commands that don't need environment
  if (firstArg === 'show') {
    showConfiguration();
    return;
  }
  
  if (firstArg === 'list') {
    await listConfigurable();
    return;
  }
  
  // For secret operations, require environment
  const environment = firstArg;
  const command = args[1];
  const secretPath = args[2];
  const value = args[3];
  
  if (!environment) {
    console.error('❌ Environment is required for secret operations');
    showHelp();
    process.exit(1);
  }
  
  if (!command || !['get', 'read', 'set', 'write'].includes(command)) {
    console.error('❌ Command is required for secret operations');
    console.error('   Usage: semiont configure <environment> <get|set> <secret-path> [value]');
    console.error('   Example: semiont configure production get oauth/google');
    process.exit(1);
  }
  
  try {
    switch (command) {
      case 'get':
      case 'read':
        if (!secretPath) {
          console.error('❌ Secret path is required');
          console.error('   Usage: semiont configure <environment> get <secret-path>');
          console.error('   Example: semiont configure production get oauth/google');
          process.exit(1);
        }
        await getSecret(environment, secretPath);
        break;
        
      case 'set':
      case 'write':
        if (!secretPath) {
          console.error('❌ Secret path is required');
          console.error('   Usage: semiont configure <environment> set <secret-path> [value]');
          console.error('   Example: semiont configure production set oauth/google');
          console.error('   Example: semiont configure staging set jwt-secret "my-secret-value"');
          process.exit(1);
        }
        await setSecret(environment, secretPath, value);
        break;
        
      default:
        showHelp();
        break;
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// ES module entry point
main();