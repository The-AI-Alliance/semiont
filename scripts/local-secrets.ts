#!/usr/bin/env -S npx tsx

/**
 * Local Secrets Management for Development
 * 
 * Manages secrets locally for development environment
 * Stores secrets in .secrets.json (gitignored)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { logger } from './lib/logger';

const SECRETS_FILE = '.secrets.json';
const BACKEND_SECRETS_FILE = path.join('apps', 'backend', '.secrets.json');

// Known local secrets and their descriptions
const LOCAL_SECRETS: Record<string, { description: string; required: boolean }> = {
  'database-password': { description: 'PostgreSQL database password for local development', required: true },
  'jwt-secret': { description: 'JWT signing secret (min 32 characters)', required: true },
  'google-client-id': { description: 'Google OAuth Client ID', required: false },
  'google-client-secret': { description: 'Google OAuth Client Secret', required: false },
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

function loadSecrets(): Record<string, string> {
  const files = [SECRETS_FILE, BACKEND_SECRETS_FILE];
  
  for (const file of files) {
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch (error) {
        logger.warn(`Failed to parse ${file}, creating new secrets file`);
      }
    }
  }
  
  return {};
}

function saveSecrets(secrets: Record<string, string>) {
  // Save to both locations for compatibility
  const files = [SECRETS_FILE, BACKEND_SECRETS_FILE];
  
  for (const file of files) {
    const dir = path.dirname(file);
    if (dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2));
    fs.chmodSync(file, 0o600); // Restrict permissions
  }
  
  // Ensure .gitignore includes these files
  const gitignores = ['.gitignore', path.join('apps', 'backend', '.gitignore')];
  for (const gitignore of gitignores) {
    if (fs.existsSync(gitignore)) {
      const content = fs.readFileSync(gitignore, 'utf-8');
      if (!content.includes('.secrets.json')) {
        fs.appendFileSync(gitignore, '\n.secrets.json\n');
      }
    }
  }
}

async function listSecrets() {
  const secrets = loadSecrets();
  
  console.log('\n📋 Local Development Secrets:\n');
  
  for (const [key, info] of Object.entries(LOCAL_SECRETS)) {
    const secretKey = key.toUpperCase().replace(/-/g, '_');
    const value = secrets[secretKey];
    const status = value ? '✅ Configured' : '❌ Not configured';
    const required = info.required ? ' (required)' : ' (optional)';
    
    console.log(`  ${key}${required}: ${status}`);
    console.log(`    ${info.description}`);
    if (value) {
      console.log(`    Value: ${maskSecret(value)}`);
    }
    console.log();
  }
}

async function getSecret(name: string) {
  const secrets = loadSecrets();
  const secretKey = name.toUpperCase().replace(/-/g, '_');
  const value = secrets[secretKey];
  
  if (!value) {
    console.log(`\n❌ Secret '${name}' is not configured`);
    console.log(`   Use: ./semiont secrets set ${name}`);
    return;
  }
  
  console.log(`\n📋 Secret: ${name}`);
  console.log(`   Value: ${maskSecret(value)}`);
}

async function setSecret(name: string) {
  const secretInfo = LOCAL_SECRETS[name];
  if (!secretInfo) {
    console.error(`\n❌ Unknown secret: ${name}`);
    console.log('\nAvailable secrets:');
    Object.keys(LOCAL_SECRETS).forEach(key => {
      console.log(`  - ${key}`);
    });
    return;
  }
  
  const rl = createReadlineInterface();
  
  try {
    console.log(`\n🔐 Configure ${name}`);
    console.log(`   ${secretInfo.description}\n`);
    
    let value: string;
    const secretKey = name.toUpperCase().replace(/-/g, '_');
    
    if (name === 'jwt-secret') {
      console.log('   JWT secret must be at least 32 characters long.');
      console.log('   You can generate one with: openssl rand -base64 32\n');
      
      value = await askQuestion(rl, 'Enter JWT secret: ');
      
      if (value.length < 32) {
        console.error('\n❌ JWT secret must be at least 32 characters long');
        process.exit(1);
      }
    } else if (name === 'database-password') {
      console.log('   This should match the password used when starting PostgreSQL.');
      console.log('   Default for Docker: localpassword\n');
      
      value = await askQuestion(rl, 'Enter database password: ');
    } else {
      value = await askQuestion(rl, `Enter ${name}: `);
    }
    
    if (!value) {
      console.log('\n❌ No value provided');
      process.exit(1);
    }
    
    const secrets = loadSecrets();
    secrets[secretKey] = value;
    saveSecrets(secrets);
    
    console.log(`\n✅ Successfully configured ${name}`);
    console.log(`   Value: ${maskSecret(value)}`);
  } finally {
    rl.close();
  }
}

// CLI
const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  try {
    switch (command) {
      case 'list':
        await listSecrets();
        break;
        
      case 'get':
        if (!args[0]) {
          console.error('Usage: local-secrets get <secret-name>');
          process.exit(1);
        }
        await getSecret(args[0]);
        break;
        
      case 'set':
        if (!args[0]) {
          console.error('Usage: local-secrets set <secret-name>');
          process.exit(1);
        }
        await setSecret(args[0]);
        break;
        
      default:
        console.log('Local secrets management for development\n');
        console.log('Usage:');
        console.log('  local-secrets list              - List all local secrets');
        console.log('  local-secrets get <name>        - Show a specific secret');
        console.log('  local-secrets set <name>        - Configure a secret');
        console.log('\nAvailable secrets:');
        Object.entries(LOCAL_SECRETS).forEach(([key, info]) => {
          const required = info.required ? ' (required)' : ' (optional)';
          console.log(`  ${key}${required} - ${info.description}`);
        });
    }
  } catch (error) {
    logger.error('Failed to manage local secrets', { error });
    process.exit(1);
  }
}

main();