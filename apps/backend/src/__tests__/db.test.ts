/**
 * Tests for database connection and Prisma client setup
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock PrismaClient
const mockPrismaClient = {
  $connect: vi.fn(),
  $disconnect: vi.fn().mockResolvedValue(undefined),
};

const mockPrismaConstructor = vi.fn(() => mockPrismaClient);

vi.mock('@prisma/client', () => ({
  PrismaClient: mockPrismaConstructor,
}));

// Unmock the db module that's being mocked in setup.ts
vi.unmock('../db');

describe('Database Connection', () => {
  let originalEnv: typeof process.env;
  let DatabaseConnection: any;
  
  beforeEach(async () => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    
    // Clear any existing global prisma
    delete (global as any).prisma;
    
    // Reset modules to get fresh instance
    vi.resetModules();
    const dbModule = await import('../db');
    DatabaseConnection = dbModule.DatabaseConnection;
  });

  afterEach(async () => {
    process.env = originalEnv;
    
    // Reset the database connection
    if (DatabaseConnection) {
      await DatabaseConnection.reset();
    }
    
    delete (global as any).prisma;
    vi.resetModules();
  });

  it('should create new PrismaClient instance', async () => {
    process.env.NODE_ENV = 'test';
    
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();
    
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'],
    });
  });

  it('should use development logging in development mode', async () => {
    process.env.NODE_ENV = 'development';
    
    vi.resetModules();
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();
    
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['query', 'error', 'warn'],
    });
  });

  it('should use error-only logging in production mode', async () => {
    process.env.NODE_ENV = 'production';
    
    vi.resetModules();
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();
    
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'],
    });
  });

  it('should use error-only logging in test mode', async () => {
    process.env.NODE_ENV = 'test';
    
    vi.resetModules();
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();
    
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'],
    });
  });

  it('should reuse existing global prisma instance', async () => {
    process.env.NODE_ENV = 'test';
    
    // Set up existing global prisma
    const existingPrisma = { 
      existing: 'client',
      $connect: vi.fn()
    };
    (global as any).prisma = existingPrisma;
    
    vi.resetModules();
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();
    
    const { PrismaClient } = await import('@prisma/client');
    expect(PrismaClient).not.toHaveBeenCalled();
    expect(prisma).toBe(existingPrisma);
  });

  it('should set global prisma in non-production environments', async () => {
    process.env.NODE_ENV = 'development';
    
    vi.resetModules();
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();

    expect((global as any).prisma).toBe(mockPrismaClient);
    expect(prisma).toBe(mockPrismaClient);
  });

  it('should not set global prisma in production environment', async () => {
    process.env.NODE_ENV = 'production';
    
    vi.resetModules();
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();

    expect((global as any).prisma).toBeUndefined();
    expect(prisma).toBe(mockPrismaClient);
  });

  it('should handle undefined NODE_ENV as non-production', async () => {
    delete process.env.NODE_ENV;
    
    vi.resetModules();
    const { DatabaseConnection } = await import('../db');
    const prisma = DatabaseConnection.getClient();
    
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'], // Default to error-only when NODE_ENV undefined
    });
    expect((global as any).prisma).toBe(mockPrismaClient); // Should set global since not production
  });

  describe('Prisma Client Configuration', () => {
    it('should configure appropriate log levels for different environments', async () => {
      const testCases = [
        { env: 'development', expectedLogs: ['query', 'error', 'warn'] },
        { env: 'production', expectedLogs: ['error'] },
        { env: 'test', expectedLogs: ['error'] },
        { env: 'staging', expectedLogs: ['error'] }, // Any non-development env
      ];

      for (const { env, expectedLogs } of testCases) {
        // Clear all state before each iteration
        delete (global as any).prisma;
        process.env.NODE_ENV = env;
        vi.resetModules();
        vi.clearAllMocks();
        mockPrismaConstructor.mockClear();
        
        const { DatabaseConnection } = await import('../db');
        const prisma = DatabaseConnection.getClient();
        
        expect(mockPrismaConstructor).toHaveBeenCalledWith({
          log: expectedLogs,
        });
      }
    });
  });

  describe('Global Instance Management', () => {
    it('should handle multiple imports consistently', async () => {
      process.env.NODE_ENV = 'development';
      
      vi.resetModules();
      const { DatabaseConnection: DB1 } = await import('../db');
      const prisma1 = DB1.getClient();
      
      // After first import creates the client, it's stored in global
      // Second import should reuse it
      const { DatabaseConnection: DB2 } = await import('../db');
      const prisma2 = DB2.getClient();

      // Both should return the same client
      expect(mockPrismaConstructor).toHaveBeenCalledTimes(1);
      expect(prisma1).toBe(prisma2);
    });

    it('should preserve global instance across different NODE_ENV values', async () => {
      // First import in development
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      const { DatabaseConnection: DevDB } = await import('../db');
      const devPrisma = DevDB.getClient();
      
      // Change to test environment but don't clear global
      process.env.NODE_ENV = 'test';
      
      // Import again - should reuse global instance
      const { DatabaseConnection: TestDB } = await import('../db');
      const testPrisma = TestDB.getClient();

      // Should have only created one instance
      expect(mockPrismaConstructor).toHaveBeenCalledTimes(1);
      expect(devPrisma).toBe(testPrisma);
    });
  });
});