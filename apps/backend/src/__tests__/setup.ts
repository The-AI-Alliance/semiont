// Test setup file for Vitest
import { vi } from 'vitest';
import { config } from 'dotenv';
import { setupMSW } from './mocks/server';

// Load test environment variables
config({ path: '.env.test' });

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

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_db';
process.env.FRONTEND_URL = 'http://localhost:3000';