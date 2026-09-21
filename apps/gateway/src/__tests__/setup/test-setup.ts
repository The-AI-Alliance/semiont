import { beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestEnvironment, type TestEnvironmentConfig } from '../_test-setup';

// Module scope, not beforeAll: a test file that imports the app at import time
// boots before any hook runs, and boot refuses without a service account.
process.env.SEMIONT_OIDC_CLIENT_ID = 'semiont-gateway';
process.env.SEMIONT_OIDC_CLIENT_SECRET = 'test-gateway-client-secret';
// The integration tests build a real SemiontProject; its state tree derives
// from XDG_STATE_HOME, which now throws when unset. Point it into temp space
// here, at module scope, before any app import.
process.env.XDG_STATE_HOME = join(tmpdir(), 'semiont-gateway-integration-state');

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