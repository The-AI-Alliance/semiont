/**
 * Tests for database connection and Prisma client setup
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock PrismaClient
const mockPrismaClient = {
  $connect: vi.fn(),
  $disconnect: vi.fn(),
};

const mockPrismaConstructor = vi.fn(() => mockPrismaClient);

vi.mock('@prisma/client', () => ({
  PrismaClient: mockPrismaConstructor,
}));

// Unmock the db module that's being mocked in setup.ts
vi.unmock('../db');

describe('Database Connection', () => {
  let originalEnv: typeof process.env;
  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    
    // Clear any existing global prisma
    delete (global as any).prisma;
  });

  afterEach(() => {
    process.env = originalEnv;
    delete (global as any).prisma;
    vi.resetModules();
  });

  it('should create new PrismaClient instance', async () => {
    process.env.NODE_ENV = 'test';
    
    vi.resetModules();
    const { prisma } = await import('../db');
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'],
    });
    expect(prisma).toBe(mockPrismaClient);
  });

  it('should use development logging in development mode', async () => {
    process.env.NODE_ENV = 'development';
    
    vi.resetModules();
    await import('../db');
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['query', 'error', 'warn'],
    });
  });

  it('should use error-only logging in production mode', async () => {
    process.env.NODE_ENV = 'production';
    
    vi.resetModules();
    await import('../db');
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'],
    });
  });

  it('should use error-only logging in test mode', async () => {
    process.env.NODE_ENV = 'test';
    
    vi.resetModules();
    await import('../db');
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'],
    });
  });

  it('should reuse existing global prisma instance', async () => {
    process.env.NODE_ENV = 'test';
    
    // Set up existing global prisma
    const existingPrisma = { existing: 'client' };
    (global as any).prisma = existingPrisma;
    
    vi.resetModules();
    const { prisma } = await import('../db');
    const { PrismaClient } = await import('@prisma/client');

    expect(PrismaClient).not.toHaveBeenCalled();
    expect(prisma).toBe(existingPrisma);
  });

  it('should set global prisma in non-production environments', async () => {
    process.env.NODE_ENV = 'development';
    
    vi.resetModules();
    const { prisma } = await import('../db');

    expect((global as any).prisma).toBe(prisma);
  });

  it('should not set global prisma in production environment', async () => {
    process.env.NODE_ENV = 'production';
    
    vi.resetModules();
    await import('../db');

    expect((global as any).prisma).toBeUndefined();
  });

  it('should handle undefined NODE_ENV as non-production', async () => {
    delete process.env.NODE_ENV;
    
    vi.resetModules();
    const { prisma } = await import('../db');
    expect(mockPrismaConstructor).toHaveBeenCalledWith({
      log: ['error'], // Default to error-only when NODE_ENV undefined
    });
    expect((global as any).prisma).toBe(prisma); // Should set global since not production
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
        
        await import('../db');
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
      const { prisma: prisma1 } = await import('../db');
      
      vi.resetModules();
      const { prisma: prisma2 } = await import('../db');

      // Should be the same instance due to global caching
      expect(prisma1).toBe(prisma2);
    });

    it('should preserve global instance across different NODE_ENV values', async () => {
      // First import in development
      process.env.NODE_ENV = 'development';
      vi.resetModules();
      const { prisma: devPrisma } = await import('../db');
      
      // Change to test environment
      process.env.NODE_ENV = 'test';
      vi.resetModules();
      const { prisma: testPrisma } = await import('../db');

      // Should reuse the same global instance
      expect(testPrisma).toBe(devPrisma);
    });
  });
});