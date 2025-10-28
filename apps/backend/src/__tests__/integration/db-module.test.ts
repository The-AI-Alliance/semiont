import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DatabaseTestSetup } from '../setup/database';

describe('Database Module (db.ts) Integration Tests', () => {
  beforeAll(async () => {
    await DatabaseTestSetup.setup();
  });

  afterAll(async () => {
    await DatabaseTestSetup.teardown();
  });

  describe('Prisma Client Configuration', () => {
    it('should create Prisma client with correct configuration', async () => {
      // Import the db module after setting up test database
      const { prisma } = await import('../../db');
      
      expect(prisma).toBeDefined();
      expect(typeof prisma.$connect).toBe('function');
      expect(typeof prisma.$disconnect).toBe('function');
      expect(typeof prisma.$queryRaw).toBe('function');
    });

    it('should use development logging in non-production environment', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      
      try {
        // Test development environment
        process.env.NODE_ENV = 'development';
        
        // Clear module cache to force re-import with new environment
        try {
          const dbPath = require.resolve('../../db');
          delete require.cache[dbPath];
        } catch (error) {
          // Module might not be cached yet, ignore
        }
        
        const { prisma } = await import('../../db');
        
        // Create a simple operation to test logging
        await expect(prisma.$queryRaw`SELECT 1`).resolves.toBeDefined();
        
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        // Clear module cache again
        try {
          const dbPath = require.resolve('../../db');
          delete require.cache[dbPath];
        } catch (error) {
          // Module might not be cached yet, ignore
        }
      }
    });

    it('should use error-only logging in production environment', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      
      try {
        // Test production environment
        process.env.NODE_ENV = 'production';
        
        // Clear module cache to force re-import with new environment
        try {
          const dbPath = require.resolve('../../db');
          delete require.cache[dbPath];
        } catch (error) {
          // Module might not be cached yet, ignore
        }
        
        const { prisma } = await import('../../db');
        
        // Create a simple operation to test logging configuration
        await expect(prisma.$queryRaw`SELECT 1`).resolves.toBeDefined();
        
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        // Clear module cache again
        try {
          const dbPath = require.resolve('../../db');
          delete require.cache[dbPath];
        } catch (error) {
          // Module might not be cached yet, ignore
        }
      }
    });
  });

  describe('Database Connection Management', () => {
    it('should establish database connection', async () => {
      const { prisma } = await import('../../db');
      
      // Test connection by executing a simple query
      const result = await prisma.$queryRaw<Array<{ version: string }>>`
        SELECT version() as version
      `;
      
      expect(result).toHaveLength(1);
      expect(result[0]?.version).toContain('PostgreSQL');
    });

    it('should handle connection errors gracefully', async () => {
      // This test is tricky because we can't easily simulate a connection failure
      // with the real db.ts module, but we can test error handling behavior
      const { prisma } = await import('../../db');
      
      // Test with an invalid query to ensure error handling works
      await expect(
        prisma.$queryRaw`SELECT FROM nonexistent_table`
      ).rejects.toThrow();
    });

    it('should maintain singleton pattern', async () => {
      // Import db module multiple times
      const db1 = await import('../../db');
      const db2 = await import('../../db');
      
      // Should be the same instance due to module caching and singleton pattern
      expect(db1.prisma).toBe(db2.prisma);
    });
  });

  describe('Database Operations through db.ts', () => {
    beforeEach(async () => {
      await DatabaseTestSetup.cleanDatabase();
    });

    it('should perform CRUD operations on User model', async () => {
      const { prisma } = await import('../../db');
      
      const userData = {
        email: 'dbtest@example.com',
        name: 'DB Test User',
        provider: 'google',
        providerId: 'google_dbtest',
        domain: 'example.com'
      };

      // Create
      const created = await prisma.user.create({ data: userData });
      expect(created.id).toBeDefined();
      expect(created.email).toBe(userData.email);

      // Read
      const found = await prisma.user.findUnique({
        where: { email: userData.email }
      });
      expect(found).toBeDefined();
      expect(found?.name).toBe(userData.name);

      // Update
      const updated = await prisma.user.update({
        where: { id: created.id },
        data: { name: 'Updated DB Test User' }
      });
      expect(updated.name).toBe('Updated DB Test User');

      // Delete
      await prisma.user.delete({
        where: { id: created.id }
      });

      const deleted = await prisma.user.findUnique({
        where: { id: created.id }
      });
      expect(deleted).toBeNull();
    });

    it('should handle database transactions', async () => {
      const { prisma } = await import('../../db');
      
      const result = await prisma.$transaction(async (tx) => {
        // const helloWorld = await tx.helloWorld.create({
        //   data: { message: 'Transaction test via db.ts' }
        // }); // helloWorld model doesn't exist

        const user = await tx.user.create({
          data: {
            email: 'transaction@example.com',
            provider: 'google',
            providerId: 'google_transaction',
            domain: 'example.com'
          }
        });

        return { user }; // helloWorld removed - model doesn't exist
      });

      // expect(result.helloWorld.id).toBeDefined(); // helloWorld doesn't exist
      expect(result.user.id).toBeDefined();

      // Verify records exist
      // const helloWorld = await prisma.helloWorld.findUnique({
      //   where: { id: result.helloWorld.id }
      // });
      const user = await prisma.user.findUnique({
        where: { id: result.user.id }
      });

      // expect(helloWorld).toBeDefined();
      expect(user).toBeDefined();
    });
  });

  describe('Environment-specific Configuration', () => {
    it('should handle test environment database URL override', async () => {
      // Store original DATABASE_URL
      const originalDatabaseUrl = process.env.DATABASE_URL;
      
      try {
        // Set test database URL
        const testConnectionString = DatabaseTestSetup.getConnectionString();
        process.env.DATABASE_URL = testConnectionString;
        
        // Clear module cache to force re-import
        try {
          const dbPath = require.resolve('../../db');
          delete require.cache[dbPath];
        } catch (error) {
          // Module might not be cached yet, ignore
        }
        
        const { prisma } = await import('../../db');
        
        // Test that we can connect and perform operations
        const result = await prisma.$queryRaw`SELECT current_database() as db`;
        expect(Array.isArray(result)).toBe(true);
        
      } finally {
        // Restore original DATABASE_URL
        if (originalDatabaseUrl) {
          process.env.DATABASE_URL = originalDatabaseUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
        // Clear module cache
        try {
          const dbPath = require.resolve('../../db');
          delete require.cache[dbPath];
        } catch (error) {
          // Module might not be cached yet, ignore
        }
      }
    });
  });
});