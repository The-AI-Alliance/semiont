/**
 * Frontend Test Environment
 * Simple, direct approach for frontend testing
 */

import { vi } from 'vitest';

export class FrontendTestEnvironment {
  private static routerMock = {
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  };

  /**
   * Setup React Router navigation mocks.
   * NOTE: The frontend's vitest.setup.ts already globally mocks react-router-dom
   * and @/i18n/routing. Call this only when you need custom per-test overrides.
   */
  static setupNavigation() {
    vi.mock('react-router-dom', async (importOriginal) => {
      const actual = await importOriginal<typeof import('react-router-dom')>();
      return {
        ...actual,
        useNavigate: () => FrontendTestEnvironment.routerMock.push,
        useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
        useParams: () => ({}),
        useSearchParams: () => [new URLSearchParams(), vi.fn()],
      };
    });
  }

  /**
   * Setup environment variables
   */
  static setupEnvironment() {
    process.env.SEMIONT_SITE_NAME = 'Test Semiont';
    process.env.SEMIONT_OAUTH_ALLOWED_DOMAINS = 'example.com,test.com';
  }

  /**
   * Setup DOM environment
   */
  static setupDOM() {
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'location', {
        value: {
          href: 'http://localhost/',
          origin: 'http://localhost',
          protocol: 'http:',
          host: 'localhost',
          hostname: 'localhost',
          port: '',
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

      global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
      global.URL.revokeObjectURL = vi.fn();
    }
  }

  /**
   * Reset all mocks
   */
  static resetMocks() {
    Object.values(this.routerMock).forEach(fn => {
      fn.mockReset();
    });
  }

  /**
   * Get router mock for custom setup
   */
  static getRouterMock() {
    return this.routerMock;
  }
}