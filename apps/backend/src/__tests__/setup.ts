// Test setup file for Vitest
import { vi } from 'vitest';
import { config } from 'dotenv';
import { setupMSW } from './mocks/server';

// Load test environment variables (skip .env.test to avoid file dependency)

// Setup MSW for mocking external HTTP requests
setupMSW();

// Mock Prisma for tests
vi.mock('../db', () => ({
  prisma: {
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
  },
}));

// Don't mock OAuthService globally - let individual tests decide

// Set test environment variables (similar to frontend setup)
// Note: Most configuration comes from config/environments/test.ts when SEMIONT_ENV=test
// These are the secrets and runtime values that can't be checked into git:
process.env.NODE_ENV = 'test';
process.env.SEMIONT_ENV = 'test';  // This triggers loading of config/environments/test.ts
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes';
process.env.DATABASE_PASSWORD = 'test-password';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';