/**
 * Global test setup for backend
 * Clean, modern approach with lazy-loading
 */

import { vi, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from './mocks/server';

// Create mock Prisma client that will be used by all tests
const mockPrismaClient = {
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $disconnect: vi.fn().mockResolvedValue(undefined),
};

// Mock the database module before any imports
vi.mock('../db', () => ({
  DatabaseConnection: {
    getClient: () => mockPrismaClient,
    setClient: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  },
  getDatabase: () => mockPrismaClient,
  // Keep prisma export for any legacy tests
  prisma: mockPrismaClient,
}));

// Mock project discovery to avoid needing actual semiont.json
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
  return {
    ...actual,
    findProjectRoot: vi.fn(() => '/tmp/test-project'),
    loadEnvironmentConfig: vi.fn(() => ({
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local'] },
      services: {
        backend: {
          platform: { type: 'posix' },
          corsOrigin: 'http://localhost:3000',
          publicURL: 'http://localhost:4000',
          port: 4000
        },
        frontend: {
          platform: { type: 'posix' },
          url: 'http://localhost:3000',
          port: 3000,
          siteName: 'Test Site'
        }
      },
      app: {}
    })),
  };
});

// Set minimal required environment variables
process.env.NODE_ENV = 'test';
process.env.SEMIONT_ENV = 'unit';
process.env.JWT_SECRET = 'test-secret-key-for-testing-32char';

// Setup MSW server for mocking HTTP requests
const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Export mocks for tests that need direct access
export { mockPrismaClient, server };