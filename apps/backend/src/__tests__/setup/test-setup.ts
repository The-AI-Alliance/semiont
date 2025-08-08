import { beforeAll, afterAll } from 'vitest';
import { DatabaseTestSetup } from './database';

// Global test setup and teardown
let isDatabaseSetup = false;

beforeAll(async () => {
  // Ensure integration test environment is properly configured
  process.env.NODE_ENV = 'test';
  
  // Load configuration based on test environment
  const testEnvironment = process.env.SEMIONT_ENV || 'unit';
  try {
    // Dynamic import of config based on environment
    const { loadConfig } = await import('semiont-config');
    const config = loadConfig(testEnvironment);
    console.log(`📋 Loaded ${testEnvironment} test configuration`);
    
    // Set DATABASE_URL from config if available (for integration tests)
    if (config.app?.backend?.database) {
      const db = config.app.backend.database;
      if (db.host && db.port && db.name && db.user && db.password) {
        const databaseUrl = `postgresql://${db.user}:${db.password}@${db.host}:${db.port}/${db.name}`;
        process.env.DATABASE_URL = databaseUrl;
        console.log('🔗 Set DATABASE_URL from configuration');
      }
    }
    
    // Set API URL if available
    if (config.app?.backend?.url) {
      process.env.API_URL = config.app.backend.url.toString();
    }
  } catch (error) {
    console.warn('⚠️  Could not load test config:', error);
    console.warn(`Using defaults for environment: ${testEnvironment}`);
  }
  
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