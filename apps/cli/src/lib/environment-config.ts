/**
 * TypeScript types for environment configuration
 */

export interface AWSConfig {
  accountId?: string;
  region: string;
  stacks?: {
    infra?: string;
    app?: string;
  };
  database?: {
    instanceClass?: string;
    multiAZ?: boolean;
    backupRetentionDays?: number;
  };
  ecs?: {
    desiredCount?: number;
    minCapacity?: number;
    maxCapacity?: number;
  };
  monitoring?: {
    enableDetailedMonitoring?: boolean;
    logRetentionDays?: number;
  };
}

export interface ServiceConfig {
  deployment?: {
    type?: string;
  };
  port?: number;
  name?: string;
  path?: string;
}

export interface EnvironmentConfig {
  _comment?: string;
  deployment?: {
    default?: string;
  };
  env?: Record<string, string>;
  aws?: AWSConfig;
  services?: Record<string, ServiceConfig>;
  site?: {
    domain?: string;
  };
}

/**
 * Type guard to check if config has AWS settings
 */
export function hasAWSConfig(config: EnvironmentConfig): config is EnvironmentConfig & { aws: AWSConfig } {
  return !!config.aws && !!config.aws.region;
}

/**
 * Get AWS region from config or environment variables
 */
export function getAWSRegion(config: EnvironmentConfig): string | undefined {
  return config?.aws?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
}

/**
 * Get AWS account ID from config
 */
export function getAWSAccountId(config: EnvironmentConfig): string | undefined {
  return config?.aws?.accountId;
}