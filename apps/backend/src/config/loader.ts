/**
 * Configuration Loader for Backend
 * 
 * Loads configuration from the shared config system instead of .env files
 * This ensures consistency between frontend and backend configuration
 */

import * as fs from 'fs';
import * as path from 'path';

// Load configuration from the config directory
function loadConfig() {
  // Check if we're in the backend directory and adjust path accordingly
  const currentDir = process.cwd();
  let configDir: string;
  
  if (currentDir.endsWith('apps/backend')) {
    configDir = path.join(currentDir, '..', '..', 'config');
  } else if (currentDir.endsWith('semiont')) {
    configDir = path.join(currentDir, 'config');
  } else {
    // Fallback to searching for config directory
    configDir = path.join(currentDir, 'config');
    if (!fs.existsSync(configDir)) {
      configDir = path.join(currentDir, '..', 'config');
      if (!fs.existsSync(configDir)) {
        configDir = path.join(currentDir, '..', '..', 'config');
      }
    }
  }
  
  // Import the config module dynamically
  try {
    // Set environment before loading config
    process.env.SEMIONT_ENV = process.env.SEMIONT_ENV || 'development';
    
    // Load the compiled config
    const configModule = require(path.join(configDir, 'index'));
    return configModule.config;
  } catch (error) {
    console.error('Failed to load configuration from', configDir);
    console.error('Make sure to run from the project root or apps/backend directory');
    throw error;
  }
}

// Load secrets from local file system (for development)
function loadLocalSecrets() {
  const secretsPath = path.join(process.cwd(), '.secrets.json');
  
  if (fs.existsSync(secretsPath)) {
    try {
      const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
      return secrets;
    } catch (error) {
      console.warn('Failed to load local secrets:', error);
      return {};
    }
  }
  
  return {};
}

// Build database URL from components
function buildDatabaseUrl(config: any, secrets: any): string {
  const backend = config.app?.backend;
  if (!backend?.database) {
    throw new Error('Backend database configuration not found');
  }
  
  const { host, port, name, user } = backend.database;
  const password = secrets.DATABASE_PASSWORD || process.env.DATABASE_PASSWORD;
  
  if (!password) {
    throw new Error('DATABASE_PASSWORD not found. Use "semiont secrets set database-password" to set it.');
  }
  
  return `postgresql://${user}:${password}@${host}:${port}/${name}`;
}

// Export configuration loader
export function loadBackendConfig() {
  const config = loadConfig();
  const secrets = loadLocalSecrets();
  
  // Build the configuration object matching the current backend expectations
  const backendConfig = {
    // Site configuration
    SITE_NAME: config.site.siteName,
    DOMAIN: config.site.domain,
    OAUTH_ALLOWED_DOMAINS: config.site.oauthAllowedDomains,
    
    // Backend specific
    PORT: config.app.backend?.port || 4000,
    NODE_ENV: config.app.nodeEnv,
    DATABASE_URL: buildDatabaseUrl(config, secrets),
    DATABASE_NAME: config.app.backend?.database?.name || 'semiont',
    
    // Security
    JWT_SECRET: secrets.JWT_SECRET || process.env.JWT_SECRET,
    
    // CORS
    CORS_ORIGIN: config.app.backend?.frontend?.url || 'http://localhost:3000',
    FRONTEND_URL: config.app.backend?.frontend?.url || 'http://localhost:3000',
    
    // OAuth (from secrets or environment)
    GOOGLE_CLIENT_ID: secrets.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: secrets.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET,
  };
  
  // Validate required fields
  if (!backendConfig.JWT_SECRET) {
    throw new Error('JWT_SECRET not found. Use "semiont secrets set jwt-secret" to set it.');
  }
  
  return backendConfig;
}