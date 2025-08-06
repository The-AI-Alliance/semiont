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

// Set unit test environment variables
// Unit tests use mock database and external services
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'unit-test-jwt-secret-key-for-testing-purposes';
process.env.DATABASE_PASSWORD = 'mock_password';
process.env.DATABASE_URL = 'postgresql://mock_user:mock_password@mock-host:5432/mock_unit_test_db';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';