#!/usr/bin/env -S npx tsx

import { SecretsManagerClient, GetSecretValueCommand, UpdateSecretCommand, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { SemiontStackConfig } from './lib/stack-config';
import { config } from '../config';
import * as readline from 'readline';

const stackConfig = new SemiontStackConfig();
const secretsClient = new SecretsManagerClient({ region: config.aws.region });

interface SecretInfo {
  name: string;
  fullName: string;
  configured: boolean;
  description?: string;
}

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

async function getSecretFullName(secretPath: string): Promise<string> {
  // Convert path format to actual secret name
  // oauth/google -> semiont-dev-oauth-google-secret (or similar based on stack config)
  const stackName = await stackConfig.getInfraStackName();
  return `${stackName}-${secretPath.replace('/', '-')}-secret`;
}

async function getCurrentSecret(secretName: string): Promise<any> {
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

async function updateSecret(secretName: string, secretValue: any): Promise<void> {
  const secretString = typeof secretValue === 'string' ? secretValue : JSON.stringify(secretValue);
  
  await secretsClient.send(
    new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: secretString,
    })
  );
}

async function listSecrets(): Promise<void> {
  console.log('📋 Available secrets:\n');
  
  const stackName = await stackConfig.getInfraStackName();
  
  // List all secrets starting with our stack name
  const response = await secretsClient.send(new ListSecretsCommand({}));
  const ourSecrets = response.SecretList?.filter(secret => 
    secret.Name?.startsWith(stackName)
  ) || [];
  
  // Show known secrets first
  for (const [secretPath, description] of Object.entries(KNOWN_SECRETS)) {
    const fullName = await getSecretFullName(secretPath);
    const exists = ourSecrets.some(s => s.Name === fullName);
    
    const status = exists ? '✅ configured' : '❌ not configured';
    console.log(`   ${secretPath.padEnd(20)} ${status}`);
    console.log(`   ${' '.repeat(20)} ${description}`);
    console.log();
  }
  
  // Show any other secrets we don't know about
  const unknownSecrets = ourSecrets.filter(secret => {
    const name = secret.Name || '';
    return !Object.keys(KNOWN_SECRETS).some(path => 
      name === stackName + '-' + path.replace('/', '-') + '-secret'
    );
  });
  
  if (unknownSecrets.length > 0) {
    console.log('   Other secrets:');
    for (const secret of unknownSecrets) {
      const name = secret.Name || '';
      const shortName = name.replace(stackName + '-', '').replace('-secret', '');
      console.log(`   ${shortName.padEnd(20)} ✅ configured`);
    }
  }
}

async function getSecret(secretPath: string): Promise<void> {
  console.log(`🔍 Reading secret: ${secretPath}\n`);
  
  const fullName = await getSecretFullName(secretPath);
  const secret = await getCurrentSecret(fullName);
  
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

async function setSecret(secretPath: string, value?: string): Promise<void> {
  console.log(`🔐 Setting secret: ${secretPath}\n`);
  
  const fullName = await getSecretFullName(secretPath);
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
    await updateSecret(fullName, secretValue);
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

async function main() {
  const command = process.argv[2];
  const secretPath = process.argv[3];
  const value = process.argv[4];
  
  try {
    switch (command) {
      case 'list':
        await listSecrets();
        break;
        
      case 'get':
      case 'read':
        if (!secretPath) {
          console.error('❌ Secret path is required');
          console.error('   Usage: semiont secrets get <secret-path>');
          console.error('   Example: semiont secrets get oauth/google');
          process.exit(1);
        }
        await getSecret(secretPath);
        break;
        
      case 'set':
      case 'write':
        if (!secretPath) {
          console.error('❌ Secret path is required');
          console.error('   Usage: semiont secrets set <secret-path> [value]');
          console.error('   Example: semiont secrets set oauth/google');
          console.error('   Example: semiont secrets set jwt-secret "my-secret-value"');
          process.exit(1);
        }
        await setSecret(secretPath, value);
        break;
        
      default:
        console.log('🔐 Semiont Secrets Manager\n');
        console.log('Usage: semiont secrets <command> [args...]\n');
        console.log('Commands:');
        console.log('   list                     - List all available secrets');
        console.log('   get <secret-path>        - Read a secret (masked)');
        console.log('   set <secret-path> [value] - Set a secret (interactive if no value)\n');
        console.log('Examples:');
        console.log('   semiont secrets list');
        console.log('   semiont secrets get oauth/google');
        console.log('   semiont secrets set oauth/google');
        console.log('   semiont secrets set jwt-secret "my-secret-32-chars-long"');
        console.log('   semiont secrets set oauth/github \'{"clientId":"...","clientSecret":"..."}\'');
        break;
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}