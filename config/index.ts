/**
 * Semiont Configuration Manager
 * 
 * Central configuration export that merges base config with environment overrides
 * and provides a clean API for accessing configuration throughout the application.
 */

import { siteConfig, awsConfig, appConfig } from './base';
import { developmentConfig } from './environments/development';
import { productionConfig } from './environments/production';
import { testConfig } from './environments/test';
import { validateConfiguration, ConfigurationError } from './schemas/validation';
import type { SemiontConfiguration, EnvironmentOverrides } from './schemas/config.schema';

// Determine current environment
const environment = process.env['SEMIONT_ENV'] || 'development';

// Select environment overrides
function getEnvironmentOverrides(): EnvironmentOverrides {
  switch (environment) {
    case 'development':
      return developmentConfig;
    case 'production':
      return productionConfig;
    case 'test':
      return testConfig;
    default:
      console.warn(`Unknown environment: ${environment}, using development config`);
      return developmentConfig;
  }
}

// Deep merge helper that handles partial types
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        result[key] = deepMerge(
          result[key] || {},
          source[key]
        );
      } else {
        result[key] = source[key];
      }
    }
  }
  
  return result;
}

// Build final configuration
function buildConfiguration(): SemiontConfiguration {
  const overrides = getEnvironmentOverrides();
  
  const config: SemiontConfiguration = {
    site: deepMerge(siteConfig, overrides.site || {}),
    aws: deepMerge(awsConfig, overrides.aws || {}),
    app: deepMerge(appConfig, overrides.app || {})
  };
  
  // Validate configuration
  try {
    validateConfiguration(config);
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(`Configuration Error: ${error.message}`);
      if (error.field) {
        console.error(`Field: ${error.field}`);
      }
      throw error;
    }
    throw error;
  }
  
  return config;
}

// Export configuration
export const config = buildConfiguration();

// Export individual sections for convenience
export const { site, aws, app } = config;

// Export types
export * from './schemas/config.schema';

// Utility functions
export function isDevelopment(): boolean {
  return environment === 'development';
}

export function isProduction(): boolean {
  return environment === 'production';
}

export function isTest(): boolean {
  return environment === 'test';
}

export function getEnvironment(): string {
  return environment;
}

export function getFullDomain(): string {
  return config.site.subdomain 
    ? `${config.site.subdomain}.${config.site.domain}`
    : config.site.domain;
}

// Configuration display for debugging (masks sensitive data)
export function displayConfiguration(): void {
  const safeConfig = JSON.parse(JSON.stringify(config));
  
  // Mask sensitive values
  safeConfig.aws.certificateArn = safeConfig.aws.certificateArn.substring(0, 30) + '...';
  safeConfig.aws.accountId = '****' + safeConfig.aws.accountId.substring(8);
  
  console.log('Current Configuration:');
  console.log(JSON.stringify(safeConfig, null, 2));
}