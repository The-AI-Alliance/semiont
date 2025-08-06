/**
 * Integration Test Environment Configuration
 * 
 * Configuration for integration tests that use real databases and services.
 * Extends base test configuration with integration-test-specific overrides.
 * 
 * Integration tests characteristics:
 * - Real database (PostgreSQL in Testcontainers)
 * - Real API endpoints (HTTP server)
 * - Real service interactions
 * - End-to-end workflow testing
 */

import type { EnvironmentOverrides } from '../schemas/config.schema';
import { testConfig } from './test';

export const integrationConfig: EnvironmentOverrides = {
  ...testConfig,
  // No stacks needed for integration tests - uses Testcontainers
  app: {
    ...testConfig.app,
    backend: {
      ...testConfig.app?.backend,
      database: {
        // Integration tests use Testcontainers for real PostgreSQL
        mockMode: false,
        useTestcontainers: true,
        // Testcontainers will override these values dynamically
        host: 'testcontainer-host', // Will be replaced by container host
        port: 5432,                // Will be replaced by container port
        name: 'semiont_integration_test',
        user: 'integration_test_user',
        password: 'integration_test_password'
      }
    },
    features: {
      ...testConfig.app?.features,
      // Enable minimal features for integration testing
      enableAnalytics: false,     // No analytics in tests
      enableMaintenanceMode: false,
      enableDebugLogging: true    // Helpful for integration debugging
    },
    performance: {
      ...testConfig.app?.performance,
      // Enable caching for more realistic testing
      enableCaching: true,
      cacheTimeout: 300  // 5 minutes
    },
    security: {
      ...testConfig.app?.security,
      // Slightly relaxed for integration testing
      sessionTimeout: 7200, // 2 hours for longer integration tests
      maxLoginAttempts: 10   // Higher limit for test scenarios
    }
  }
};