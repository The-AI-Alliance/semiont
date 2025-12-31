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
   * Setup Next.js navigation mocks
   */
  static setupNavigation() {
    vi.mock('next/navigation', () => ({
      useRouter: () => FrontendTestEnvironment.routerMock,
      useSearchParams: () => ({
        get: vi.fn(),
      }),
      usePathname: () => '/',
      redirect: vi.fn(),
      notFound: vi.fn(),
    }));
  }

  /**
   * Setup NextAuth mocks
   */
  static setupAuth() {
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
      SessionProvider: ({ children }: any) => children,
    }));
  }

  /**
   * Setup environment variables
   */
  static setupEnvironment() {
    process.env.NEXT_PUBLIC_SITE_NAME = 'Test Semiont';
    process.env.SERVER_API_URL = 'http://localhost:3001';
    process.env.NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS = 'example.com,test.com';
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