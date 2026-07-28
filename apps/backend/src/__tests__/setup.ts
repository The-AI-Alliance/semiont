/**
 * Global test setup for backend
 * Clean, modern approach with lazy-loading
 */

import { vi, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from './mocks/server';
import { promises as fs, mkdirSync, writeFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { EnvironmentConfig } from '@semiont/core';

// Create mock Prisma client that will be used by all tests
const mockPrismaClient = {
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
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

// Use a unique directory per worker thread to avoid race conditions
const testDir = `/tmp/semiont-test-${process.pid}-${uuidv4()}`;

// Mock config loader to provide in-memory config (no filesystem needed)
vi.mock('../utils/config', () => ({
  makeMeaningConfigFrom: vi.fn(() => ({ services: {}, actors: undefined, workers: undefined })),
  loadEnvironmentConfig: vi.fn((_projectRoot: string, _env: string): EnvironmentConfig => ({
    services: {
      backend: {
        platform: { type: 'posix' as const },
        port: 4000,
        publicURL: 'http://localhost:4000',
      },
      filesystem: {
        platform: { type: 'posix' as const },
        path: testDir,
      },
      graph: {
        platform: { type: 'posix' as const },
        type: 'memory' as const,
      },
    },
    site: {
      siteName: 'Test Site',
      domain: 'localhost',
      adminEmail: 'admin@test.local',
      oauthAllowedDomains: ['test.local'],
    },
    env: {
      NODE_ENV: 'test' as const,
    },
    _metadata: {
      environment: 'unit',
      projectRoot: testDir,
    },
  })),
}));

// Set minimal required environment variables
process.env.NODE_ENV = 'test';
process.env.SEMIONT_ENV = 'unit';
process.env.SEMIONT_ROOT = testDir;
process.env.JWT_SECRET = 'test-secret-key-for-testing-32char';

// The KB's own committed config. Written SYNCHRONOUSLY here, not in
// `beforeAll`: boot reads it when a test file imports the app, which for some
// files happens at module load — before any hook has run.
//
// `[site] domain` is the KB's permanent identity, and boot now refuses a KB
// without one (KB-IDENTITY-VS-ADDRESS decision 8), so a fixture lacking it is
// not a valid knowledge base. The value mirrors the mocked environment
// config's `site.domain` on purpose: matching keeps these fixtures in the
// ordinary, non-diverged case and therefore silent (a mismatch warns —
// decision 10).
mkdirSync(`${testDir}/.semiont`, { recursive: true });
writeFileSync(
  `${testDir}/.semiont/config`,
  '[project]\nname = "semiont-backend-unit"\n\n[site]\ndomain = "localhost"\n',
  'utf-8',
);

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