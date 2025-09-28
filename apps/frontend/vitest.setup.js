/**
 * Global test setup for frontend
 * Clean, modern approach with lazy-loading
 */

import '@testing-library/jest-dom';
import { vi, beforeAll, afterEach, afterAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from './src/mocks/server';

// Start MSW server
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => {
  server.resetHandlers();
  // Cleanup React components to prevent memory leaks
  cleanup();
  // Clear all timers to prevent hanging async operations
  vi.clearAllTimers();
});
afterAll(() => server.close());

// Mock Next.js navigation before any imports
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => ({
    get: vi.fn(),
  }),
  usePathname: () => '/',
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

// Mock NextAuth
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(() => ({
    data: null,
    status: 'unauthenticated',
  })),
  signIn: vi.fn(),
  signOut: vi.fn(),
  SessionProvider: ({ children }) => children,
}));

// Set test environment variables
process.env.NEXT_PUBLIC_SITE_NAME = 'Test Semiont';
process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3001';
process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS = 'example.com,test.com';

// Polyfill fetch to handle relative URLs
const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  // Convert relative URLs to absolute URLs for test environment
  if (typeof input === 'string' && input.startsWith('/')) {
    input = `http://localhost:3000${input}`;
  }
  return originalFetch(input, init);
};

// Mock window methods
if (typeof window !== 'undefined') {
  // Polyfill animations API for Headless UI
  if (!window.Element.prototype.getAnimations) {
    window.Element.prototype.getAnimations = function() {
      return [];
    };
  }

  // Mock window.location
  Object.defineProperty(window, 'location', {
    value: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      protocol: 'http:',
      host: 'localhost:3000',
      hostname: 'localhost',
      port: '3000',
      pathname: '/',
      search: '',
      hash: '',
      reload: vi.fn(),
      replace: vi.fn(),
      assign: vi.fn(),
    },
    writable: true,
    configurable: true,
  });

  // Mock URL methods
  global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = vi.fn();
}