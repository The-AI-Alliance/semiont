/**
 * Global test setup for frontend
 */

import '@testing-library/jest-dom';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// AbortController polyfill for ky compatibility
if (typeof global.AbortController === 'undefined') {
  global.AbortController = AbortController;
  global.AbortSignal = AbortSignal;
}

// DOMMatrix polyfill for PDF.js
if (typeof globalThis !== 'undefined' && !(globalThis as any).DOMMatrix) {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  };
}

// window.matchMedia mock for theme detection
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

// Polyfill animations API for Headless UI
if (!window.Element.prototype.getAnimations) {
  window.Element.prototype.getAnimations = function () {
    return [];
  };
}

// window.location mock
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

// URL object mocks
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
global.URL.revokeObjectURL = vi.fn();

// Relative URL fetch polyfill
const originalFetch = global.fetch;
global.fetch = async (input, init) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    input = `http://localhost:3000${input}`;
  }
  return originalFetch(input, init);
};

// Next.js navigation mock
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => ({ get: vi.fn() }),
  usePathname: () => '/',
  redirect: vi.fn(),
  notFound: vi.fn(),
  useParams: () => ({ locale: 'en' }),
}));

// NextAuth mocks
vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(() => ({ data: null, status: 'unauthenticated' })),
  signIn: vi.fn(),
  signOut: vi.fn(),
  SessionProvider: ({ children }: any) => children,
}));

// next-intl mock with actual English translations
vi.mock('next-intl', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const translationsPath = path.join(__dirname, 'messages', 'en.json');
  const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf8'));

  const mockTranslations = (namespace: string) => {
    return (key: string, params?: Record<string, unknown>) => {
      const namespaceData = translations[namespace] || {};
      let result: string = namespaceData[key] || key;
      if (params) {
        Object.entries(params).forEach(([paramKey, paramValue]) => {
          result = result.replace(`{${paramKey}}`, String(paramValue));
        });
      }
      return result;
    };
  };

  return {
    useTranslations: vi.fn((namespace: string) => mockTranslations(namespace)),
    useLocale: vi.fn(() => 'en'),
    NextIntlClientProvider: ({ children }: any) => children,
    useMessages: vi.fn(() => translations),
  };
});

// next-intl/routing mock
vi.mock('next-intl/routing', () => ({
  defineRouting: vi.fn((config: unknown) => config),
}));

// next-intl/navigation mock
vi.mock('next-intl/navigation', async () => {
  const React = await import('react');

  const MockLink = ({ children, href, ...props }: any) =>
    React.createElement('a', { href, ...props },
      typeof children === 'function' ? children({ isActive: false }) : children
    );

  return {
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
    Link: MockLink,
    createNavigation: vi.fn(() => {
      const { usePathname, useRouter } = require('next/navigation');
      return { Link: MockLink, redirect: vi.fn(), usePathname, useRouter };
    }),
  };
});

// Environment variables
process.env.NEXT_PUBLIC_SITE_NAME = 'Test Semiont';
process.env.SERVER_API_URL = 'http://localhost:3001';
process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS = 'example.com,test.com';

// Cleanup between tests
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});
