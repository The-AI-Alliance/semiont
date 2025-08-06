/**
 * Unit Test Environment Configuration
 * 
 * Configuration for unit tests that mock all external dependencies.
 * Extends base test configuration with unit-test-specific overrides.
 * 
 * Unit tests characteristics:
 * - Fast execution (no external services)
 * - Isolated (no database, no network calls)  
 * - Mocked dependencies (Prisma, OAuth, external APIs)
 * - Focused on business logic testing
 */

import type { EnvironmentOverrides } from '../schemas/config.schema';
import { testConfig } from './test';

export const unitConfig: EnvironmentOverrides = {
  ...testConfig,
  _meta: {
    type: 'test',
    description: 'Unit tests with mocked dependencies'
  },
  app: {
    ...testConfig.app,
    backend: {
      ...testConfig.app?.backend,
      database: {
        ...testConfig.app?.backend?.database,
        // Unit tests mock the database - no real connection needed
        mockMode: true,
        useTestcontainers: false,
        // Mock DATABASE_URL to prevent connection attempts
        host: 'mock-host',
        port: 5432,
        name: 'mock_unit_test_db',
        user: 'mock_user',
        password: 'mock_password'
      }
    },
    features: {
      ...testConfig.app?.features,
      // Disable all external features for unit tests
      enableAnalytics: false,
      enableMaintenanceMode: false,
      enableDebugLogging: false
    },
    performance: {
      ...testConfig.app?.performance,
      // No caching in unit tests
      enableCaching: false,
      cacheTimeout: 0
    }
  }
};