/**
 * Configuration Schema Definitions
 * Provides type safety and validation for all configuration
 */

// CDK Stack class references - import the actual stack classes
import type { SemiontAppStack } from '../cdk/lib/app-stack';
import type { SemiontInfraStack } from '../cdk/lib/infra-stack';

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
export interface SemiontConfiguration {
  site: SiteConfiguration;
  aws: AWSConfiguration;
  app: ApplicationConfiguration;
}

// Deep partial type for nested overrides
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// Stack reference interface - using actual TypeScript class types
export interface CloudStackReferences {
  infraStack: typeof SemiontInfraStack;
  appStack: typeof SemiontAppStack;
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

// Environment-specific override interface
export interface EnvironmentOverrides {
  // Stack references - for cloud environments only
  stacks?: CloudStackReferences;
  
  site?: Partial<SiteConfiguration>;
  aws?: DeepPartial<AWSConfiguration>;
  app?: ApplicationConfigurationOverride;
}