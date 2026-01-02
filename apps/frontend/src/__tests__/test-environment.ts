/**
 * Frontend Test Environment with lazy initialization
 * 
 * Provides centralized test setup for Next.js frontend tests
 * with on-demand initialization
 */

import { vi } from 'vitest';
import type { SetupServer } from 'msw/node';

interface RouterMock {
  push: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  prefetch: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  forward: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}

interface NavigationMocks {
  useRouter: () => RouterMock;
  useSearchParams: () => { get: ReturnType<typeof vi.fn> };
  usePathname: () => string;
  redirect: ReturnType<typeof vi.fn>;
  notFound: ReturnType<typeof vi.fn>;
}

export class FrontendTestEnvironment {
  private static instance: FrontendTestEnvironment | null = null;
  private mswServer: SetupServer | null = null;
  private routerMock: RouterMock | null = null;
  private navigationMocks: NavigationMocks | null = null;
  private originalEnv: NodeJS.ProcessEnv;
  private isInitialized = false;
  private domMocksSetup = false;

  private constructor() {
    // Store original environment
    this.originalEnv = { ...process.env };
  }

  /**
   * Get singleton instance
   */
  static getInstance(): FrontendTestEnvironment {
    if (!this.instance) {
      this.instance = new FrontendTestEnvironment();
    }
    return this.instance;
  }

  /**
   * Initialize test environment (lazy)
   */
  async initialize(options?: {
    mockAPI?: boolean;
    mockRouter?: boolean;
    mockAuth?: boolean;
    setupDOM?: boolean;
  }) {
    if (this.isInitialized && !options) {
      return;
    }

    const config = {
      mockAPI: true,
      mockRouter: true,
      mockAuth: true,
      setupDOM: true,
      ...options
    };

    // Set environment variables
    this.setEnvironmentVariables();

    // Setup DOM environment if needed
    if (config.setupDOM && !this.domMocksSetup) {
      this.setupDOMEnvironment();
    }

    // Initialize MSW for API mocking if needed
    if (config.mockAPI) {
      await this.setupMSW();
    }

    // Initialize router mocks if needed
    if (config.mockRouter) {
      this.setupRouterMocks();
    }

    // Initialize auth mocks if needed
    if (config.mockAuth) {
      this.setupAuthMocks();
    }

    this.isInitialized = true;
  }

  /**
   * Set frontend-specific environment variables
   */
  private setEnvironmentVariables() {
    Object.assign(process.env, {
      NEXT_PUBLIC_SITE_NAME: 'Test Semiont',
      SERVER_API_URL: 'http://localhost:3001',
      NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: 'example.com,test.com',
      NODE_ENV: 'test',
    });
  }

  /**
   * Setup DOM environment for component testing
   */
  private setupDOMEnvironment() {
    // Mock window.location
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

    // Mock URL methods
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();

    // Mock fetch if not already available
    if (!global.fetch) {
      global.fetch = vi.fn();
    }

    this.domMocksSetup = true;
  }

  /**
   * Setup MSW for API mocking
   */
  private async setupMSW(): Promise<SetupServer> {
    if (!this.mswServer) {
      const { server } = await import('../mocks/server');
      this.mswServer = server;
      this.mswServer.listen({
        onUnhandledRequest: 'warn'
      });
    }
    return this.mswServer;
  }

  /**
   * Get MSW server (if initialized)
   */
  getMSWServer(): SetupServer | null {
    return this.mswServer;
  }

  /**
   * Setup Next.js router mocks
   */
  private setupRouterMocks() {
    if (!this.routerMock) {
      this.routerMock = {
        push: vi.fn(),
        replace: vi.fn(),
        prefetch: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
      };
    }

    if (!this.navigationMocks) {
      this.navigationMocks = {
        useRouter: () => this.routerMock!,
        useSearchParams: () => ({
          get: vi.fn(),
        }),
        usePathname: () => '/',
        redirect: vi.fn(),
        notFound: vi.fn(),
      };
    }

    // Mock next/navigation
    vi.doMock('next/navigation', () => this.navigationMocks || {});
  }

  /**
   * Get router mock for custom configuration
   */
  getRouterMock(): RouterMock | null {
    return this.routerMock;
  }

  /**
   * Update router pathname
   */
  setPathname(pathname: string) {
    if (this.navigationMocks) {
      this.navigationMocks.usePathname = () => pathname;
    }
  }

  /**
   * Setup NextAuth mocks
   */
  private setupAuthMocks() {
    vi.doMock('next-auth', () => ({
      getServerSession: vi.fn(),
    }));

    vi.doMock('next-auth/react', () => ({
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
   * Set authenticated user for tests
   */
  setAuthenticatedUser(user: any) {
    const session = {
      user,
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    vi.mocked(require('next-auth/react').useSession).mockReturnValue({
      data: session,
      status: 'authenticated',
      update: vi.fn(),
    });

    vi.mocked(require('next-auth').getServerSession).mockResolvedValue(session);
  }

  /**
   * Update environment variables
   */
  setEnvVars(vars: Record<string, string>) {
    Object.assign(process.env, vars);
  }

  /**
   * Reset mocks but keep environment
   */
  resetMocks() {
    // Reset router mocks
    if (this.routerMock) {
      Object.values(this.routerMock).forEach(mockFn => {
        mockFn.mockReset();
      });
    }

    // Reset MSW handlers
    if (this.mswServer) {
      this.mswServer.resetHandlers();
    }

    // Reset auth mocks
    vi.mocked(require('next-auth').getServerSession).mockReset();
    vi.mocked(require('next-auth/react').useSession).mockReset();
  }

  /**
   * Full reset - restore original environment
   */
  async reset() {
    // Restore original environment
    process.env = { ...this.originalEnv };

    // Reset all mocks
    this.resetMocks();

    // Close MSW if running
    if (this.mswServer) {
      this.mswServer.close();
      this.mswServer = null;
    }

    // Clear mock instances
    this.routerMock = null;
    this.navigationMocks = null;

    // Clear module mocks
    vi.unmock('next/navigation');
    vi.unmock('next-auth');
    vi.unmock('next-auth/react');

    this.isInitialized = false;
  }

  /**
   * Clean up (for afterAll)
   */
  async cleanup() {
    await this.reset();
    FrontendTestEnvironment.instance = null;
  }
}

/**
 * Convenience function for quick setup
 */
export async function setupFrontendTest(options?: Parameters<FrontendTestEnvironment['initialize']>[0]) {
  const env = FrontendTestEnvironment.getInstance();
  await env.initialize(options);
  return env;
}