/**
 * Global test setup for the Browser
 */

import '@testing-library/jest-dom';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

/** What the mocked `Link`s take: an anchor's attributes, a route, and a render function for `NavLink`'s children. */
type MockLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> & {
  children?: ReactNode | ((state: { isActive: boolean }) => ReactNode);
  to?: string;
};

// AbortController polyfill for ky compatibility
if (typeof global.AbortController === 'undefined') {
  global.AbortController = AbortController;
  global.AbortSignal = AbortSignal;
}

// DOMMatrix polyfill for PDF.js
if (typeof globalThis !== 'undefined' && !('DOMMatrix' in globalThis)) {
  Object.defineProperty(globalThis, 'DOMMatrix', {
    value: class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    },
    writable: true,
    configurable: true,
  });
}

// window.matchMedia mock for theme detection (jsdom only — node-environment
// tests, e.g. the static server's, have no window)
if (typeof window !== 'undefined') Object.defineProperty(window, 'matchMedia', {
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
if (typeof window !== 'undefined' && !window.Element.prototype.getAnimations) {
  window.Element.prototype.getAnimations = function () {
    return [];
  };
}

// window.location mock
if (typeof window !== 'undefined') Object.defineProperty(window, 'location', {
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

// react-router mock
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  const React = await import('react');

  const MockLink = ({ children, to, href, ...props }: MockLinkProps) => {
    const target = to ?? href;
    return React.createElement('a', target === undefined ? props : { ...props, href: target },
      typeof children === 'function' ? children({ isActive: false }) : children
    );
  };

  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/en', search: '', hash: '', state: null }),
    useParams: () => ({ locale: 'en' }),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    Link: MockLink,
    Navigate: ({ to }: { to: string }) => React.createElement('div', { 'data-testid': 'navigate', 'data-to': to }),
    BrowserRouter: ({ children }: { children?: ReactNode }) => React.createElement(React.Fragment, null, children),
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
  const translations: Record<string, Record<string, string> | undefined> = JSON.parse(fs.readFileSync(translationsPath, 'utf8'));

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

  // react-i18next's own scoping: `useTranslation(ns, { keyPrefix })` hands back
  // a `t` that reads every key under the prefix. One per prefix, so it is as
  // stable from render to render as the real one.
  const scoped = new Map<string, typeof tFn>();
  const tUnder = (keyPrefix: string | undefined) => {
    if (keyPrefix === undefined) return tFn;
    const known = scoped.get(keyPrefix);
    if (known) return known;
    const t = (key: string, params?: Record<string, unknown>) => tFn(`${keyPrefix}.${key}`, params);
    scoped.set(keyPrefix, t);
    return t;
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
    useTranslation: vi.fn((_ns?: string, options?: { keyPrefix?: string }) => ({ t: tUnder(options?.keyPrefix), i18n: i18nInstance })),
    initReactI18next: { type: '3rdParty', init: vi.fn() },
    I18nextProvider: ({ children }: { children?: ReactNode }) => children,
    Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  };
});

// @/i18n/routing mock
vi.mock('@/i18n/routing', async () => {
  const React = await import('react');

  const MockLink = ({ children, to, href, ...props }: MockLinkProps) => {
    const target = to ?? href;
    return React.createElement('a', target === undefined ? props : { ...props, href: target },
      typeof children === 'function' ? children({ isActive: false }) : children
    );
  };

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

// Cleanup between tests
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});
