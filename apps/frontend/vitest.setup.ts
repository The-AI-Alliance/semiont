/**
 * Global test setup for frontend
 * Uses lazy-loading TestEnvironment for better performance
 */

import '@testing-library/jest-dom';
import { beforeAll, afterEach, afterAll } from 'vitest';
import { FrontendTestEnvironment } from './src/__tests__/test-environment';

let testEnv: FrontendTestEnvironment;

beforeAll(async () => {
  // Get test environment instance
  testEnv = FrontendTestEnvironment.getInstance();
  
  // Initialize with default settings (lazy - only when first test runs)
  await testEnv.initialize({
    mockAPI: true,
    mockRouter: true,
    mockAuth: true,
    setupDOM: true
  });
});

afterEach(() => {
  // Reset mocks between tests for isolation
  if (testEnv) {
    testEnv.resetMocks();
  }
});

afterAll(async () => {
  // Full cleanup after all tests
  if (testEnv) {
    await testEnv.cleanup();
  }
});

// Export for tests that need direct access
export { testEnv };