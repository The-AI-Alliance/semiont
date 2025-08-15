/**
 * Backend Test Environment
 * Simple, direct approach for backend testing
 */

import { vi } from 'vitest';

export class BackendTestEnvironment {
  private static mockPrismaClient = {
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

  /**
   * Setup database mocks
   */
  static setupDatabase() {
    vi.mock('../db', () => ({
      DatabaseConnection: {
        getClient: () => BackendTestEnvironment.mockPrismaClient,
        setClient: vi.fn(),
        reset: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      },
      getDatabase: () => BackendTestEnvironment.mockPrismaClient,
      prisma: BackendTestEnvironment.mockPrismaClient,
    }));
  }

  /**
   * Setup environment configuration
   */
  static setupEnvironment(env: 'unit' | 'integration' = 'unit') {
    process.env.NODE_ENV = 'test';
    process.env.SEMIONT_ENV = env;
    process.env.JWT_SECRET = 'test-secret-key-for-testing-32char';
    
    if (env === 'unit') {
      process.env.DATABASE_URL = 'postgresql://mock:mock@localhost:5432/mock_test';
    }
  }

  /**
   * Reset all mocks
   */
  static resetMocks() {
    Object.values(this.mockPrismaClient.user).forEach(fn => {
      if (typeof fn.mockReset === 'function') {
        fn.mockReset();
      }
    });
    this.mockPrismaClient.$queryRaw.mockReset();
    this.mockPrismaClient.$disconnect.mockReset();
  }

  /**
   * Get mock client for custom setup
   */
  static getMockPrismaClient() {
    return this.mockPrismaClient;
  }
}