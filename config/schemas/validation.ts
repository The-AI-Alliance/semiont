/**
 * Configuration Validation
 * 
 * Runtime validation to ensure configuration integrity
 */

import type { SemiontConfiguration } from './config.schema';

export class ConfigurationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function validateConfiguration(config: SemiontConfiguration): void {
  // Validate site configuration
  validateSiteConfig(config.site);
  
  // Validate AWS configuration
  validateAWSConfig(config.aws);
  
  // Validate app configuration
  validateAppConfig(config.app);
}

function validateSiteConfig(site: SemiontConfiguration['site']): void {
  if (!site.siteName || site.siteName.trim().length === 0) {
    throw new ConfigurationError('Site name is required', 'site.siteName');
  }
  
  if (!site.domain || !isValidDomain(site.domain)) {
    throw new ConfigurationError('Valid domain is required', 'site.domain');
  }
  
  if (!site.adminEmail || !isValidEmail(site.adminEmail)) {
    throw new ConfigurationError('Valid admin email is required', 'site.adminEmail');
  }
  
  if (site.oauthAllowedDomains.length === 0) {
    throw new ConfigurationError('At least one OAuth allowed domain is required', 'site.oauthAllowedDomains');
  }
  
  site.oauthAllowedDomains.forEach(domain => {
    if (!isValidDomain(domain)) {
      throw new ConfigurationError(`Invalid OAuth domain: ${domain}`, 'site.oauthAllowedDomains');
    }
  });
}

function validateAWSConfig(aws: SemiontConfiguration['aws']): void {
  if (!aws.region || !isValidAWSRegion(aws.region)) {
    throw new ConfigurationError('Valid AWS region is required', 'aws.region');
  }
  
  if (!aws.accountId || !isValidAWSAccountId(aws.accountId)) {
    throw new ConfigurationError('Valid AWS account ID is required', 'aws.accountId');
  }
  
  if (!aws.certificateArn || !isValidARN(aws.certificateArn)) {
    throw new ConfigurationError('Valid certificate ARN is required', 'aws.certificateArn');
  }
  
  if (!aws.hostedZoneId) {
    throw new ConfigurationError('Hosted zone ID is required', 'aws.hostedZoneId');
  }
  
  if (!aws.rootDomain || !isValidDomain(aws.rootDomain)) {
    throw new ConfigurationError('Valid root domain is required', 'aws.rootDomain');
  }
  
  // Validate database config
  if (aws.database.allocatedStorage && (aws.database.allocatedStorage < 20 || aws.database.allocatedStorage > 65536)) {
    throw new ConfigurationError('Database storage must be between 20 and 65536 GB', 'aws.database.allocatedStorage');
  }
  
  if (aws.database.backupRetentionDays !== undefined && (aws.database.backupRetentionDays < 0 || aws.database.backupRetentionDays > 35)) {
    throw new ConfigurationError('Backup retention must be between 0 and 35 days', 'aws.database.backupRetentionDays');
  }
}

function validateAppConfig(app: SemiontConfiguration['app']): void {
  if (!['development', 'staging', 'production', 'test'].includes(app.nodeEnv)) {
    throw new ConfigurationError('Invalid NODE_ENV value', 'app.nodeEnv');
  }
  
  if (app.security.sessionTimeout && app.security.sessionTimeout < 300) { // 5 minutes minimum
    throw new ConfigurationError('Session timeout must be at least 300 seconds', 'app.security.sessionTimeout');
  }
  
  if (app.security.maxLoginAttempts && app.security.maxLoginAttempts < 1) {
    throw new ConfigurationError('Max login attempts must be at least 1', 'app.security.maxLoginAttempts');
  }
}

// Validation helpers
function isValidDomain(domain: string): boolean {
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  return domainRegex.test(domain);
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidAWSRegion(region: string): boolean {
  const regionRegex = /^[a-z]{2}-[a-z]+-[0-9]{1}$/;
  return regionRegex.test(region);
}

function isValidAWSAccountId(accountId: string): boolean {
  return /^\d{12}$/.test(accountId);
}

function isValidARN(arn: string): boolean {
  return arn.startsWith('arn:aws:');
}