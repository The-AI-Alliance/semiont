import { beforeAll, afterAll } from 'vitest';
import { DatabaseTestSetup } from './database';

// Global test setup and teardown
let isDatabaseSetup = false;

beforeAll(async () => {
  // Ensure integration test environment is properly configured
  process.env.NODE_ENV = 'test';
  
  // Set test environment for configuration loading
  const testEnvironment = process.env.SEMIONT_ENV || 'unit';
  process.env.SEMIONT_ENV = testEnvironment;
  
  try {
    // Load environment configuration using the unified system
    const { loadEnvironmentConfig } = await import('@semiont/config-loader');
    const config = loadEnvironmentConfig(testEnvironment);
    console.log(`📋 Loaded ${testEnvironment} test configuration`);
    
    // Set DATABASE_URL from config if available (for integration tests)
    if (config.services?.database) {
      const db = config.services.database;
      if (db.host && db.port && db.name && db.user) {
        // For tests, we'll use the password from environment variables
        const password = process.env.DATABASE_PASSWORD || 'integration_test_password';
        const databaseUrl = `postgresql://${db.user}:${password}@${db.host}:${db.port}/${db.name}`;
        process.env.DATABASE_URL = databaseUrl;
        console.log('🔗 Set DATABASE_URL from configuration');
      }
    }
  } catch (error) {
    console.warn('⚠️  Could not load test config:', error);
    console.warn(`Using defaults for environment: ${testEnvironment}`);
  }
  
  // Configure Testcontainers early to avoid Node.js crashes
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  
  // Set test secrets
  process.env.JWT_SECRET = 'test-secret-key-for-testing-32char';
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