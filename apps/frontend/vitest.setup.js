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
// Note: Must be defined before next-intl mock since next-intl depends on it
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
  useParams: () => ({ locale: 'en' }),
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

// Mock next-intl with actual English translations
vi.mock('next-intl', async () => {
  // Load the actual English translations
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const translationsPath = path.join(__dirname, 'messages', 'en.json');
  const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf8'));

  const mockTranslations = (namespace) => {
    return (key, params) => {
      // Get the translation from the namespace
      const namespaceData = translations[namespace] || {};
      let result = namespaceData[key] || key;

      // Handle parameterized translations (like {date})
      if (params) {
        Object.entries(params).forEach(([paramKey, paramValue]) => {
          result = result.replace(`{${paramKey}}`, String(paramValue));
        });
      }

      return result;
    };
  };

  return {
    useTranslations: vi.fn((namespace) => mockTranslations(namespace)),
    useLocale: vi.fn(() => 'en'),
    NextIntlClientProvider: ({ children }) => children,
    useMessages: vi.fn(() => translations),
  };
});

// Mock next-intl/routing
vi.mock('next-intl/routing', () => ({
  defineRouting: vi.fn((config) => config),
}));

// Mock next-intl/navigation (which depends on next/navigation)
vi.mock('next-intl/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/',
  redirect: vi.fn(),
  Link: ({ children, href, ...props }) => {
    // Simple Link component mock
    return typeof children === 'function'
      ? children({ isActive: false })
      : children;
  },
  createNavigation: vi.fn(() => ({
    Link: ({ children, href, ...props }) => {
      return typeof children === 'function'
        ? children({ isActive: false })
        : children;
    },
    redirect: vi.fn(),
    usePathname: () => '/',
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    }),
  })),
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