/**
 * Configuration Loader for Backend
 * 
 * Loads configuration from the shared config system instead of .env files
 * This ensures consistency between frontend and backend configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig as loadConfigFromPackage } from '@semiont/config-loader';

// Load configuration from the config loader package
function loadConfig(environment = 'development') {
  try {
    return loadConfigFromPackage(environment);
  } catch (error) {
    console.error('Failed to load configuration');
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
  // Determine environment for configuration loading
  // Local development gets 'local' config, production gets 'production', tests get 'development'
  let environment: string;
  if (process.env.NODE_ENV === 'production') {
    environment = 'production';
  } else if (process.env.NODE_ENV === 'test') {
    environment = 'development'; // Tests use development-like config
  } else {
    environment = 'local'; // Local development uses local config
  }
  const config = loadConfig(environment);
  const secrets = loadLocalSecrets();
  
  // Build the configuration object matching the current backend expectations
  const backendConfig = {
    // Site configuration
    SITE_NAME: config.site.siteName,
    DOMAIN: config.site.domain,
    OAUTH_ALLOWED_DOMAINS: config.site.oauthAllowedDomains,
    
    // Backend specific
    PORT: config.app.backend?.port || 4000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    DATABASE_URL: buildDatabaseUrl(config, secrets),
    DATABASE_NAME: config.app.backend?.database?.name || 'semiont',
    
    // Security
    JWT_SECRET: secrets.JWT_SECRET || process.env.JWT_SECRET,
    
    // CORS
    CORS_ORIGIN: config.app.backend?.frontend ? 
      `http://${config.app.backend.frontend.host}:${config.app.backend.frontend.port}` : 
      'http://localhost:3000',
    FRONTEND_URL: config.app.backend?.frontend ? 
      `http://${config.app.backend.frontend.host}:${config.app.backend.frontend.port}` : 
      'http://localhost:3000',
    
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