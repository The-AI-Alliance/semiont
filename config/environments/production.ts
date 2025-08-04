/**
 * Production Environment Configuration
 * 
 * Production-specific overrides and settings
 */

import type { EnvironmentOverrides } from '../schemas/config.schema';

export const productionConfig: EnvironmentOverrides = {
  site: {
    // Production-specific site configuration (example values - MUST BE CUSTOMIZED)
    domain: 'wiki.example.com',
    adminEmail: 'admin@example.com',
    supportEmail: 'support@example.com',
    oauthAllowedDomains: ['example.com']
  },
  app: {
    nodeEnv: 'production',
    features: {
      enableAnalytics: true,
      enableMaintenanceMode: false,
      enableDebugLogging: false
    },
    security: {
      sessionTimeout: 28800, // 8 hours
      maxLoginAttempts: 5
    },
    performance: {
      enableCaching: true,
      cacheTimeout: 300 // 5 minutes
    }
  },
  aws: {
    // Production-specific AWS configuration (example values - MUST BE CUSTOMIZED)
    accountId: '123456789012',
    certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012',
    hostedZoneId: 'Z1234567890ABC',
    rootDomain: 'example.com',
    database: {
      multiAZ: true,  // Enable Multi-AZ for production
      backupRetentionDays: 7
    },
    ecs: {
      desiredCount: 2,
      minCapacity: 2,
      maxCapacity: 10
    },
    monitoring: {
      enableDetailedMonitoring: true,
      logRetentionDays: 30
    }
  }
};