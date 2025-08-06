import { beforeAll, afterAll } from 'vitest';
import { DatabaseTestSetup } from './database';

// Global test setup and teardown
let isDatabaseSetup = false;

beforeAll(async () => {
  // Ensure integration test environment is properly configured
  process.env.NODE_ENV = 'test';
  
  // Configure Testcontainers early to avoid Node.js crashes
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  
  // Set integration test secrets
  process.env.JWT_SECRET = 'integration-test-jwt-secret-key-for-testing-environment';
  process.env.DATABASE_PASSWORD = 'integration_test_password';
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  
  // Only set up database for integration tests
  const testPath = expect.getState().testPath;
  const isIntegrationTest = testPath?.includes('integration') || 
                          testPath?.includes('database') ||
                          process.env.VITEST_DATABASE_TESTS === 'true';
  
  if (isIntegrationTest && !isDatabaseSetup) {
    console.log('🚀 Setting up test database for integration tests...');
    await DatabaseTestSetup.setup();
    isDatabaseSetup = true;
  } else {
    // For non-integration tests, set a mock DATABASE_URL to prevent connection attempts
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = 'postgresql://mock_user:mock_password@mock-host:5432/mock_integration_test_db';
    }
  }
}, 120000); // 2 minutes timeout for container startup

afterAll(async () => {
  if (isDatabaseSetup) {
    console.log('🛑 Tearing down test database...');
    await DatabaseTestSetup.teardown();
    isDatabaseSetup = false;
  }
}, 30000); // 30 seconds timeout for cleanup