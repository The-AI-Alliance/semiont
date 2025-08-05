// Test setup file for Vitest
import { vi } from 'vitest';
import { config } from 'dotenv';

// Load test environment variables
config({ path: '.env.test' });

// Mock Prisma for tests
vi.mock('../db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

// Mock OAuthService for tests
vi.mock('../auth/oauth', () => ({
  OAuthService: {
    getUserFromToken: vi.fn(),
    verifyGoogleToken: vi.fn(),
    createOrUpdateUser: vi.fn(),
  },
}));

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';