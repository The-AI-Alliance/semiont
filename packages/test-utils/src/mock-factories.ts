/**
 * Reusable mock factories for common test scenarios
 */

import { vi } from 'vitest';
import { faker } from '@faker-js/faker';

/**
 * Create a mock user object
 */
export function createMockUser(overrides?: Partial<any>) {
  return {
    id: faker.string.uuid(),
    email: faker.internet.email(),
    name: faker.person.fullName(),
    image: faker.image.avatar(),
    domain: faker.internet.domainName(),
    provider: 'google',
    providerId: `google-${faker.string.alphanumeric(10)}`,
    isAdmin: false,
    isActive: true,
    termsAcceptedAt: null,
    lastLogin: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

/**
 * Create a mock session object
 */
export function createMockSession(user?: any) {
  return {
    user: user || createMockUser(),
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Create a mock JWT payload
 */
export function createMockJWTPayload(overrides?: Partial<any>) {
  const user = createMockUser();
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    domain: user.domain,
    provider: user.provider,
    isAdmin: user.isAdmin,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
    ...overrides
  };
}

/**
 * Create a mock Prisma client
 */
export function createMockPrismaClient() {
  return {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };
}

/**
 * Create a mock HTTP request
 */
export function createMockRequest(overrides?: Partial<any>) {
  return {
    method: 'GET',
    url: 'http://localhost:3000',
    headers: new Map(),
    body: null,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
    formData: vi.fn().mockResolvedValue(new FormData()),
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    blob: vi.fn().mockResolvedValue(new Blob([])),
    ...overrides
  };
}

/**
 * Create a mock HTTP response
 */
export function createMockResponse(overrides?: Partial<any>) {
  const response = {
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    body: null,
    json: vi.fn(),
    text: vi.fn(),
    redirect: vi.fn(),
    ...overrides
  };

  // Chain methods
  response.json.mockReturnValue(response);
  response.text.mockReturnValue(response);
  response.redirect.mockReturnValue(response);

  return response;
}

/**
 * Create a mock Next.js router
 */
export function createMockRouter(overrides?: Partial<any>) {
  return {
    push: vi.fn().mockResolvedValue(true),
    replace: vi.fn().mockResolvedValue(true),
    prefetch: vi.fn().mockResolvedValue(undefined),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    reload: vi.fn(),
    pathname: '/',
    query: {},
    asPath: '/',
    basePath: '',
    locale: 'en',
    locales: ['en'],
    defaultLocale: 'en',
    isReady: true,
    isPreview: false,
    ...overrides
  };
}

/**
 * Create a mock logger
 */
export function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

/**
 * Create a mock file system
 */
export function createMockFileSystem() {
  const files = new Map<string, string>();
  
  return {
    readFile: vi.fn((path: string) => {
      if (files.has(path)) {
        return Promise.resolve(files.get(path));
      }
      return Promise.reject(new Error(`File not found: ${path}`));
    }),
    writeFile: vi.fn((path: string, content: string) => {
      files.set(path, content);
      return Promise.resolve();
    }),
    existsSync: vi.fn((path: string) => files.has(path)),
    mkdirSync: vi.fn(),
    rmSync: vi.fn((path: string) => files.delete(path)),
    readdirSync: vi.fn(() => Array.from(files.keys())),
    statSync: vi.fn((path: string) => ({
      isFile: () => true,
      isDirectory: () => false,
      size: files.get(path)?.length || 0,
    })),
    // Helper methods for testing
    _setFile: (path: string, content: string) => files.set(path, content),
    _getFile: (path: string) => files.get(path),
    _clear: () => files.clear(),
    _getFiles: () => new Map(files),
  };
}

/**
 * Create a mock environment configuration
 */
export function createMockEnvironmentConfig(overrides?: Partial<any>) {
  return {
    name: 'test',
    description: 'Test environment',
    services: {
      backend: {
        port: 4000,
        host: 'localhost',
        protocol: 'http',
      },
      frontend: {
        port: 3000,
        host: 'localhost',
        protocol: 'http',
      },
    },
    database: {
      provider: 'postgresql',
      host: 'localhost',
      port: 5432,
      name: 'semiont_test',
      user: 'test_user',
    },
    auth: {
      jwtSecret: 'test-secret',
      allowedDomains: ['example.com', 'test.com'],
    },
    ...overrides
  };
}

/**
 * Create mock API handlers for MSW
 */
export function createMockAPIHandlers() {
  return {
    health: vi.fn().mockReturnValue({
      status: 'operational',
      timestamp: new Date().toISOString(),
    }),
    auth: {
      login: vi.fn().mockReturnValue({
        token: 'mock-jwt-token',
        user: createMockUser(),
      }),
      logout: vi.fn().mockReturnValue({ success: true }),
      me: vi.fn().mockReturnValue(createMockUser()),
    },
    users: {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
}