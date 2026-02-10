/**
 * Global test setup for backend
 * Clean, modern approach with lazy-loading
 */

import { vi, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from './mocks/server';
import { promises as fs } from 'fs';

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
    checkHealth: vi.fn().mockResolvedValue(true),
  },
  getDatabase: () => mockPrismaClient,
  // Keep prisma export for any legacy tests
  prisma: mockPrismaClient,
}));

// Mock project discovery to avoid needing actual semiont.json
// Use a unique directory per worker thread to avoid race conditions
const testDir = `/tmp/semiont-test-${process.pid}-${Date.now()}`;

// Mock the config-loader module (where findProjectRoot and loadEnvironmentConfig now live)
vi.mock('../config-loader', () => ({
  findProjectRoot: vi.fn(() => '/tmp/test-project'),
  loadEnvironmentConfig: vi.fn(() => ({
    site: { domain: 'test.local', oauthAllowedDomains: ['test.local'] },
    env: {
      NODE_ENV: 'test'
    },
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
      },
      filesystem: {
        platform: { type: 'posix' },
        path: testDir
      }
    },
    app: {}
  })),
}));

// Set minimal required environment variables
process.env.NODE_ENV = 'test';
process.env.SEMIONT_ENV = 'unit';
process.env.JWT_SECRET = 'test-secret-key-for-testing-32char';

// Setup MSW server for mocking HTTP requests
const server = setupServer(...handlers);

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'warn' });

  // Create the directory structure that the mocked config references
  // This ensures JobQueue initialization doesn't fail with ENOENT
  try {
    await fs.mkdir(`${testDir}/jobs/pending`, { recursive: true });
    await fs.mkdir(`${testDir}/jobs/running`, { recursive: true });
    await fs.mkdir(`${testDir}/jobs/complete`, { recursive: true });
    await fs.mkdir(`${testDir}/jobs/failed`, { recursive: true });
    await fs.mkdir(`${testDir}/jobs/cancelled`, { recursive: true });
  } catch (error) {
    // Ignore errors if directories already exist
  }
});

afterEach(() => server.resetHandlers());

afterAll(async () => {
  server.close();

  // Clean up the test directory
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});

// Export mocks and testDir for tests that need direct access
export { mockPrismaClient, server, testDir };