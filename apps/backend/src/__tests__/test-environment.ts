/**
 * Backend Test Environment with lazy initialization
 * 
 * Provides centralized test setup with on-demand initialization
 * for better performance and test isolation
 */

import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

interface MockPrismaClient {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  $queryRaw: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
}

export class BackendTestEnvironment {
  private static instance: BackendTestEnvironment | null = null;
  private mockPrismaClient: MockPrismaClient | null = null;
  private originalEnv: NodeJS.ProcessEnv;
  private mswServer: any = null;
  private isInitialized = false;

  private constructor() {
    // Store original environment
    this.originalEnv = { ...process.env };
  }

  /**
   * Get singleton instance
   */
  static getInstance(): BackendTestEnvironment {
    if (!this.instance) {
      this.instance = new BackendTestEnvironment();
    }
    return this.instance;
  }

  /**
   * Initialize test environment (lazy)
   */
  async initialize(options?: {
    mockDatabase?: boolean;
    mockMSW?: boolean;
    environment?: 'unit' | 'integration';
  }) {
    if (this.isInitialized && !options) {
      return;
    }

    const config = {
      mockDatabase: true,
      mockMSW: true,
      environment: 'unit' as const,
      ...options
    };

    // Set base environment variables
    this.setEnvironmentVariables(config.environment);

    // Initialize database mocks if needed
    if (config.mockDatabase) {
      this.setupDatabaseMocks();
    }

    // Initialize MSW if needed
    if (config.mockMSW) {
      await this.setupMSW();
    }

    this.isInitialized = true;
  }

  /**
   * Set environment variables based on test type
   */
  private setEnvironmentVariables(environment: 'unit' | 'integration') {
    const baseVars = {
      NODE_ENV: 'test',
      SEMIONT_ENV: environment,
      JWT_SECRET: 'test-secret-key-for-testing-32char',
    };

    const envSpecificVars = environment === 'unit' 
      ? {
          DATABASE_URL: 'postgresql://mock_user:mock_password@mock-host:5432/mock_unit_test_db',
          DATABASE_PASSWORD: 'mock_password',
          GOOGLE_CLIENT_ID: 'test-google-client-id',
          GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
        }
      : {
          DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5432/semiont_test',
          // Integration tests use real services where possible
        };

    Object.assign(process.env, baseVars, envSpecificVars);
  }

  /**
   * Get or create mock Prisma client
   */
  getMockPrismaClient(): MockPrismaClient {
    if (!this.mockPrismaClient) {
      this.mockPrismaClient = this.createMockPrismaClient();
    }
    return this.mockPrismaClient;
  }

  /**
   * Create a fresh mock Prisma client
   */
  private createMockPrismaClient(): MockPrismaClient {
    return {
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
  }

  /**
   * Setup database mocks
   */
  private setupDatabaseMocks() {
    const mockClient = this.getMockPrismaClient();
    
    // Mock the db module - need to do this before any imports
    vi.mock('../db', () => ({
      prisma: mockClient,
      DatabaseConnection: {
        getClient: () => mockClient,
        setClient: vi.fn(),
        reset: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      },
      getDatabase: () => mockClient,
    }));
  }

  /**
   * Setup MSW for API mocking
   */
  private async setupMSW() {
    if (!this.mswServer) {
      const { setupMSW } = await import('./mocks/server');
      this.mswServer = setupMSW();
    }
    return this.mswServer;
  }

  /**
   * Get MSW server instance (if initialized)
   */
  getMSWServer() {
    return this.mswServer;
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
    if (this.mockPrismaClient) {
      // Reset all mock functions
      Object.values(this.mockPrismaClient.user).forEach(mockFn => {
        if (typeof mockFn.mockReset === 'function') {
          mockFn.mockReset();
        }
      });
      this.mockPrismaClient.$queryRaw.mockReset();
      this.mockPrismaClient.$disconnect.mockReset();
    }

    if (this.mswServer) {
      this.mswServer.resetHandlers();
    }
  }

  /**
   * Full reset - restore original environment
   */
  async reset() {
    // Restore original environment
    process.env = { ...this.originalEnv };

    // Reset mocks
    this.resetMocks();

    // Clear mock instances
    this.mockPrismaClient = null;

    // Close MSW if running
    if (this.mswServer) {
      this.mswServer.close();
      this.mswServer = null;
    }

    // Clear module mocks
    vi.unmock('../db');

    this.isInitialized = false;
  }

  /**
   * Clean up (for afterAll)
   */
  async cleanup() {
    await this.reset();
    BackendTestEnvironment.instance = null;
  }
}

/**
 * Convenience function for quick setup
 */
export async function setupBackendTest(options?: Parameters<BackendTestEnvironment['initialize']>[0]) {
  const env = BackendTestEnvironment.getInstance();
  await env.initialize(options);
  return env;
}