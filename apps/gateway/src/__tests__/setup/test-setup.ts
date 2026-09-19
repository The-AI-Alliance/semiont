import { beforeAll, afterAll } from 'vitest';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';

// Global test setup and teardown
let testEnv: TestEnvironmentConfig | null = null;

beforeAll(async () => {
  // Create proper Semiont project structure for integration tests.
  // The environment is passed explicitly — it used to arrive via SEMIONT_ENV=integration
  // in the npm script, which is exactly the ambient input this harness no longer relies on.
  testEnv = await setupTestEnvironment('integration');

  // Ensure integration test environment is properly configured
  process.env.NODE_ENV = 'test';

  // Set test secrets
  process.env.JWT_SECRET = 'test-secret-key-for-testing-32char';

  // Only set up database for integration tests
  // No database is started. The gateway holds no database: it reads every
  // caller's identity off their token, so the Testcontainers PostgreSQL this
  // harness used to boot had nothing left to serve.
}, 120000);

afterAll(async () => {
  if (testEnv) {
    console.log('🧹 Cleaning up test project...');
    await testEnv.cleanup();
    testEnv = null;
  }
}, 30000); // 30 seconds timeout for cleanup