/**
 * Configuration Schema Definitions
 * Provides type safety and validation for all configuration
 */

// CDK Stack class references - will be resolved at runtime by string name

export interface SiteConfiguration {
  // Site branding
  siteName: string;
  siteDescription?: string;
  
  // Domain configuration
  domain: string;
  subdomain?: string;
  
  // Contact information
  adminEmail: string;
  supportEmail?: string;
  
  // OAuth configuration
  oauthAllowedDomains: string[];
  oauthProviders: OAuthProvider[];
}

export interface AWSConfiguration {
  // Core AWS settings
  region: string;
  accountId: string;
  
  // Stack configuration
  stackPrefix?: string;
  infraStackName?: string;
  appStackName?: string;
  
  // Infrastructure
  certificateArn: string;
  hostedZoneId: string;
  rootDomain: string;
  
  // Resource configuration
  database: DatabaseConfig;
  ecs?: ECSConfig;
  monitoring?: MonitoringConfig;
}

export interface ApplicationConfiguration {
  // Feature flags
  features: {
    enableAnalytics?: boolean;
    enableMaintenanceMode?: boolean;
    enableDebugLogging?: boolean;
  };
  
  // Security
  security: {
    sessionTimeout?: number;  // in seconds
    maxLoginAttempts?: number;
    corsAllowedOrigins?: string[];
  };
  
  // Performance
  performance: {
    enableCaching?: boolean;
    cacheTimeout?: number;
    maxRequestSize?: string;  // e.g., '10mb'
  };
  
  // Backend configuration
  backend?: {
    url?: URL;
    database?: {
      host?: string;
      port?: number;
      name?: string;
      user?: string;
      // Test-specific options
      mockMode?: boolean;           // For unit tests - don't connect to real DB
      useTestcontainers?: boolean;  // For integration tests - use Testcontainers
      password?: string;            // Optional password (usually from secrets)
    };
  };
  
  // Frontend configuration
  frontend?: {
    url?: URL;
  };
}

export interface DatabaseConfig {
  name: string;
  instanceClass?: string;
  allocatedStorage?: number;
  backupRetentionDays?: number;
  multiAZ?: boolean;
}

export interface ECSConfig {
  cpu?: number;
  memory?: number;
  desiredCount?: number;
  maxCapacity?: number;
  minCapacity?: number;
}

export interface MonitoringConfig {
  enableDetailedMonitoring?: boolean;
  logRetentionDays?: number;
  alertEmail?: string;
}

export interface OAuthProvider {
  name: 'google' | 'github' | 'okta';
  enabled: boolean;
  clientIdEnvVar?: string;  // Name of env var containing client ID
  secretName?: string;      // AWS Secrets Manager secret name
}

// Complete configuration interface

// Stack reference interface - using string names for runtime resolution
export interface CloudStackReferences {
  infraStack: string;
  appStack: string;
}

// Application configuration override interface (allows string URLs)
export interface ApplicationConfigurationOverride {
  // Feature flags
  features?: {
    enableAnalytics?: boolean;
    enableMaintenanceMode?: boolean;
    enableDebugLogging?: boolean;
  };
  
  // Security
  security?: {
    sessionTimeout?: number;  // in seconds
    maxLoginAttempts?: number;
    corsAllowedOrigins?: string[];
  };
  
  // Performance
  performance?: {
    enableCaching?: boolean;
    cacheTimeout?: number;
    maxRequestSize?: string;  // e.g., '10mb'
  };
  
  // Backend configuration (allows string URLs for overrides)
  backend?: {
    url?: URL | string;
    database?: {
      host?: string;
      port?: number;
      name?: string;
      user?: string;
      // Test-specific options
      mockMode?: boolean;           // For unit tests - don't connect to real DB
      useTestcontainers?: boolean;  // For integration tests - use Testcontainers
      password?: string;            // Optional password (usually from secrets)
    };
  };
  
  // Frontend configuration (allows string URLs for overrides)
  frontend?: {
    url?: URL | string;
  };
}

// New schema types
export interface DeploymentConfiguration {
  default: 'process' | 'container' | 'aws' | 'mock';
}

export interface ServiceConfiguration {
  deployment?: {
    type: 'process' | 'container' | 'aws' | 'mock' | 'external';
  };
  command?: string;
  port?: number;
  host?: string;
  name?: string;
  user?: string;
  multiAZ?: boolean;
  backupRetentionDays?: number;
}

export interface CloudConfiguration {
  aws?: {
    stacks?: {
      infra?: string;
      app?: string;
    };
  };
}

// Environment configuration interface
// AWS configuration that must include region when specified
export interface AWSEnvironmentConfig {
  region: string;  // Required - no defaults!
  accountId: string;  // Required - no defaults!
  certificateArn?: string;
  hostedZoneId?: string;
  rootDomain?: string;
  database?: Partial<DatabaseConfig>;
  ecs?: Partial<ECSConfig>;
  monitoring?: Partial<MonitoringConfig>;
}

export interface EnvironmentConfig {
  _comment?: string;
  _extends?: string;
  deployment?: DeploymentConfiguration;
  site?: Partial<SiteConfiguration>;
  app?: ApplicationConfigurationOverride;
  services?: {
    backend?: ServiceConfiguration;
    frontend?: ServiceConfiguration;
    database?: ServiceConfiguration;
  };
  cloud?: CloudConfiguration;
  aws?: AWSEnvironmentConfig;  // If aws exists, region is required
}

// Environment-specific override interface
export interface EnvironmentOverrides extends EnvironmentConfig {}