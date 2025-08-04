/**
 * AWS Infrastructure Configuration
 * 
 * Contains all AWS-specific settings required for deployment.
 * These values are typically obtained from your AWS account and
 * infrastructure setup.
 */

import type { AWSConfiguration } from '../schemas/config.schema';

export const awsConfig: AWSConfiguration = {
  // Core AWS settings
  region: process.env.AWS_REGION || 'us-east-2',
  accountId: process.env.AWS_ACCOUNT_ID || '',
  
  // Stack configuration
  stackPrefix: 'Semiont',
  infraStackName: process.env.INFRA_STACK_NAME || 'SemiontInfraStack',
  appStackName: process.env.APP_STACK_NAME || 'SemiontAppStack',
  
  // Infrastructure - Must be configured in environment-specific configs
  certificateArn: process.env.CERTIFICATE_ARN || '',
  hostedZoneId: process.env.HOSTED_ZONE_ID || '',
  rootDomain: process.env.ROOT_DOMAIN || '',
  
  // Database configuration
  database: {
    name: process.env.DATABASE_NAME || 'semiont',
    instanceClass: process.env.DB_INSTANCE_CLASS || 'db.t3.micro',
    allocatedStorage: parseInt(process.env.DB_STORAGE || '20', 10),
    backupRetentionDays: parseInt(process.env.DB_BACKUP_RETENTION || '7', 10),
    multiAZ: process.env.DB_MULTI_AZ === 'true' || false
  },
  
  // ECS configuration
  ecs: {
    cpu: parseInt(process.env.ECS_CPU || '256', 10),
    memory: parseInt(process.env.ECS_MEMORY || '512', 10),
    desiredCount: parseInt(process.env.ECS_DESIRED_COUNT || '2', 10),
    maxCapacity: parseInt(process.env.ECS_MAX_CAPACITY || '4', 10),
    minCapacity: parseInt(process.env.ECS_MIN_CAPACITY || '1', 10)
  },
  
  // Monitoring configuration
  monitoring: {
    enableDetailedMonitoring: process.env.ENABLE_DETAILED_MONITORING === 'true' || false,
    logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '7', 10),
    alertEmail: process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL
  }
};