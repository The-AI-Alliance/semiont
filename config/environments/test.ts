/**
 * Test Environment Configuration
 * 
 * Test-specific overrides for unit testing and CI/CD
 */

import type { EnvironmentOverrides } from '../schemas/config.schema';

export const testConfig: EnvironmentOverrides = {
  site: {
    // Test-specific site configuration
    domain: 'test.example.com',
    adminEmail: 'admin@test.example.com',
    supportEmail: 'support@test.example.com',
    oauthAllowedDomains: ['test.example.com', 'example.org']
  },
  app: {
    nodeEnv: 'test',
    features: {
      enableAnalytics: false,
      enableMaintenanceMode: false,
      enableDebugLogging: false
    },
    security: {
      sessionTimeout: 3600, // 1 hour for tests
      maxLoginAttempts: 5,
      corsAllowedOrigins: ['http://localhost:3000']
    },
    performance: {
      enableCaching: false,  // Disable caching for tests
      cacheTimeout: 0
    }
  },
  aws: {
    // Test-specific AWS configuration
    accountId: '123456789012',
    certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
    hostedZoneId: 'ZTESTZONEID123',
    rootDomain: 'example.com',
    database: {
      multiAZ: false,  // Single AZ for tests
      backupRetentionDays: 1
    },
    ecs: {
      desiredCount: 1,
      minCapacity: 1,
      maxCapacity: 1
    },
    monitoring: {
      enableDetailedMonitoring: false,
      logRetentionDays: 1
    }
  }
};