import { beforeAll, afterAll } from 'vitest';
import { DatabaseTestSetup } from './database';

// Global test setup and teardown
let isDatabaseSetup = false;

beforeAll(async () => {
  // Only set up database for integration tests
  const testPath = expect.getState().testPath;
  const isIntegrationTest = testPath?.includes('integration') || 
                          testPath?.includes('database') ||
                          process.env.VITEST_DATABASE_TESTS === 'true';
  
  if (isIntegrationTest && !isDatabaseSetup) {
    console.log('🚀 Setting up test database for integration tests...');
    await DatabaseTestSetup.setup();
    isDatabaseSetup = true;
  }
}, 120000); // 2 minutes timeout for container startup

afterAll(async () => {
  if (isDatabaseSetup) {
    console.log('🛑 Tearing down test database...');
    await DatabaseTestSetup.teardown();
    isDatabaseSetup = false;
  }
}, 30000); // 30 seconds timeout for cleanup