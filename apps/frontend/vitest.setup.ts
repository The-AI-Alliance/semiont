/**
 * Global test setup for frontend
 * Uses lazy-loading TestEnvironment for better performance
 */

import '@testing-library/jest-dom';
import { beforeAll, afterEach, afterAll, vi } from 'vitest';
import { FrontendTestEnvironment } from './src/__tests__/test-environment';

// Ensure we use Node's native AbortController for ky compatibility
if (typeof global.AbortController === 'undefined') {
  global.AbortController = AbortController;
  global.AbortSignal = AbortSignal;
}

// Mock DOMMatrix for PDF.js in test environment
if (typeof globalThis !== 'undefined' && !(globalThis as any).DOMMatrix) {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    constructor() {
      // Minimal implementation for PDF.js compatibility
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
    }
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  };
}

// Mock window.matchMedia for theme detection
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock next-intl globally
vi.mock('next-intl');

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