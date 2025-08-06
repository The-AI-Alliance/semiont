/**
 * Base Test Environment Configuration
 * 
 * This serves as the base configuration for all test environments.
 * It provides common test settings that are shared between different test types.
 * 
 * Environment Hierarchy:
 * - test.ts (this file) - Base test configuration with common settings
 * - unit.ts - Extends test.ts, adds mockMode for isolated unit tests
 * - integration.ts - Extends test.ts, adds Testcontainers for integration tests
 * 
 * Direct Usage:
 * This configuration is NOT typically used directly. Instead, tests should use:
 * - SEMIONT_ENV=unit for unit tests (fast, mocked dependencies)
 * - SEMIONT_ENV=integration for integration tests (real database via Testcontainers)
 * 
 * Note: Secrets like JWT_SECRET, DATABASE_PASSWORD, and OAuth credentials
 * are set in apps/backend/src/__tests__/setup.ts as environment variables
 * since they shouldn't be committed to git.
 */

import type { EnvironmentOverrides } from '../schemas/config.schema';

export const testConfig: EnvironmentOverrides = {
  _meta: {
    type: 'test',
    description: 'Base test configuration with local-like settings'
  },
  site: {
    // Test-specific site configuration
    domain: 'test.example.com',
    adminEmail: 'admin@test.example.com',
    supportEmail: 'support@test.example.com',
    oauthAllowedDomains: ['test.example.com', 'example.org']
  },
  app: {
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
    },
    backend: {
      url: 'http://localhost:3001',
      database: {
        host: 'localhost',
        port: 5432,
        name: 'semiont_test',
        user: 'test_user'
      }
    },
    frontend: {
      url: 'http://localhost:3000'
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