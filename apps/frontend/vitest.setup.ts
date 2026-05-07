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
  value: vi.fn().mockImplementation((query: string) => ({
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

// react-router-dom mock
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const React = await import('react');

  const MockLink = ({ children, to, href, ...props }: any) =>
    React.createElement('a', { href: to ?? href, ...props },
      typeof children === 'function' ? children({ isActive: false }) : children
    );

  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/en', search: '', hash: '', state: null }),
    useParams: () => ({ locale: 'en' }),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    Link: MockLink,
    Navigate: ({ to }: any) => React.createElement('div', { 'data-testid': 'navigate', 'data-to': to }),
    BrowserRouter: ({ children }: any) => React.createElement(React.Fragment, null, children),
    MemoryRouter: actual.MemoryRouter,
  };
});

// react-i18next mock with actual English translations
vi.mock('react-i18next', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const translationsPath = path.join(__dirname, 'messages', 'en.json');
  const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf8'));

  const tFn = (key: string, params?: Record<string, unknown>) => {
    // key format: "Namespace.subkey"
    const dotIndex = key.indexOf('.');
    if (dotIndex === -1) return key;
    const namespace = key.slice(0, dotIndex);
    const subkey = key.slice(dotIndex + 1);
    const namespaceData = translations[namespace] || {};
    let result: string = namespaceData[subkey] ?? key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        result = result.replace(`{{${k}}}`, String(v));
      });
    }
    return result;
  };

  const i18nInstance = {
    language: 'en',
    changeLanguage: vi.fn().mockResolvedValue(undefined),
    hasResourceBundle: vi.fn(() => true),
    getResourceBundle: vi.fn(() => translations),
    on: vi.fn(),
    off: vi.fn(),
  };

  return {
    useTranslation: vi.fn(() => ({ t: tFn, i18n: i18nInstance })),
    initReactI18next: { type: '3rdParty', init: vi.fn() },
    I18nextProvider: ({ children }: any) => children,
    Trans: ({ i18nKey }: any) => i18nKey,
  };
});

// @/i18n/routing mock
vi.mock('@/i18n/routing', async () => {
  const React = await import('react');

  const MockLink = ({ children, to, href, ...props }: any) =>
    React.createElement('a', { href: to ?? href, ...props }, children);

  return {
    Link: MockLink,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    usePathname: () => '/',
    useLocale: () => 'en',
    redirect: vi.fn(),
  };
});

// Environment variables
process.env.SEMIONT_SITE_NAME = 'Test Semiont';
process.env.SEMIONT_OAUTH_ALLOWED_DOMAINS = 'example.com,test.com';

// Cleanup between tests
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});
