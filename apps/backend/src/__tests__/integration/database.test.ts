import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseTestSetup } from '../setup/database';

describe('Database Integration Tests', () => {
  let testPrisma: PrismaClient;
  let connectionString: string;

  beforeAll(async () => {
    const setup = await DatabaseTestSetup.setup();
    testPrisma = setup.prisma;
    connectionString = setup.connectionString;
  });

  afterAll(async () => {
    await DatabaseTestSetup.teardown();
  });

  beforeEach(async () => {
    // Clean up data between tests
    await DatabaseTestSetup.cleanDatabase();
  });

  describe('Database Connection & Basic Operations', () => {
    it('should establish database connection', async () => {
      expect(testPrisma).toBeDefined();
      
      // Test basic query
      const result = await testPrisma.$queryRaw<Array<{ test: number }>>`SELECT 1 as test`;
      expect(result).toEqual([{ test: 1 }]);
    });

    it('should connect to correct database', async () => {
      const dbInfo = await testPrisma.$queryRaw<Array<{ current_database: string }>>`
        SELECT current_database()
      `;
      expect(dbInfo[0].current_database).toBe('semiont_test');
    });

    it('should have correct schema tables', async () => {
      const tables = await testPrisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `;
      
      const tableNames = tables.map(t => t.table_name);
      expect(tableNames).toContain('HelloWorld');
      expect(tableNames).toContain('users');
      // Note: _prisma_migrations table is only created by 'prisma migrate dev', 
      // not by 'prisma db push' which we use in tests
    });
  });

  describe('HelloWorld Model Operations', () => {
    it('should create and retrieve HelloWorld records', async () => {
      const testMessage = 'Hello from integration test!';
      
      const created = await testPrisma.helloWorld.create({
        data: { message: testMessage }
      });

      expect(created.id).toBeDefined();
      expect(created.message).toBe(testMessage);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);

      const found = await testPrisma.helloWorld.findUnique({
        where: { id: created.id }
      });
      
      expect(found).toMatchObject({
        id: created.id,
        message: testMessage
      });
    });

    it('should update HelloWorld records', async () => {
      const created = await testPrisma.helloWorld.create({
        data: { message: 'Original message' }
      });

      // Wait a small amount to ensure updatedAt timestamp differs
      await new Promise(resolve => setTimeout(resolve, 10));

      const updatedMessage = 'Updated message';
      const updated = await testPrisma.helloWorld.update({
        where: { id: created.id },
        data: { message: updatedMessage }
      });

      expect(updated.message).toBe(updatedMessage);
      expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    });

    it('should delete HelloWorld records', async () => {
      const created = await testPrisma.helloWorld.create({
        data: { message: 'To be deleted' }
      });

      await testPrisma.helloWorld.delete({
        where: { id: created.id }
      });

      const found = await testPrisma.helloWorld.findUnique({
        where: { id: created.id }
      });

      expect(found).toBeNull();
    });

    it('should handle multiple HelloWorld records', async () => {
      const messages = ['Message 1', 'Message 2', 'Message 3'];
      
      // Create records sequentially to ensure consistent ordering
      const created = [];
      for (const message of messages) {
        const record = await testPrisma.helloWorld.create({ data: { message } });
        created.push(record);
        // Small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(created).toHaveLength(3);

      const all = await testPrisma.helloWorld.findMany({
        orderBy: { createdAt: 'asc' }
      });

      expect(all).toHaveLength(3);
      expect(all.map(h => h.message)).toEqual(messages);
    });
  });

  describe('User Model Operations', () => {
    const createUserData = (overrides = {}) => ({
      email: 'test@example.com',
      name: 'Test User',
      provider: 'google',
      providerId: 'google_123',
      domain: 'example.com',
      ...overrides
    });

    it('should create and retrieve users', async () => {
      const userData = createUserData();
      
      const user = await testPrisma.user.create({ data: userData });
      
      expect(user.id).toBeDefined();
      expect(user.email).toBe(userData.email);
      expect(user.name).toBe(userData.name);
      expect(user.provider).toBe(userData.provider);
      expect(user.providerId).toBe(userData.providerId);
      expect(user.domain).toBe(userData.domain);
      expect(user.isActive).toBe(true); // default value
      expect(user.isAdmin).toBe(false); // default value
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);

      const foundUser = await testPrisma.user.findUnique({
        where: { email: userData.email }
      });
      
      expect(foundUser).toMatchObject(userData);
    });

    it('should enforce unique email constraint', async () => {
      const userData = createUserData();
      
      await testPrisma.user.create({ data: userData });
      
      await expect(
        testPrisma.user.create({ 
          data: { ...userData, providerId: 'google_456' } 
        })
      ).rejects.toThrow();
    });

    it('should enforce unique provider+providerId constraint', async () => {
      const userData = createUserData();
      
      await testPrisma.user.create({ data: userData });
      
      await expect(
        testPrisma.user.create({ 
          data: { ...userData, email: 'different@example.com' } 
        })
      ).rejects.toThrow();
    });

    it('should handle admin users', async () => {
      const adminData = createUserData({ 
        email: 'admin@example.com',
        isAdmin: true 
      });
      
      const admin = await testPrisma.user.create({ data: adminData });
      expect(admin.isAdmin).toBe(true);

      const foundAdmin = await testPrisma.user.findFirst({
        where: { isAdmin: true }
      });
      
      expect(foundAdmin?.email).toBe(adminData.email);
    });

    it('should handle optional fields', async () => {
      const minimalUser = {
        email: 'minimal@example.com',
        provider: 'google',
        providerId: 'google_minimal',
        domain: 'example.com'
      };
      
      const user = await testPrisma.user.create({ data: minimalUser });
      
      expect(user.name).toBeNull();
      expect(user.image).toBeNull();
      expect(user.termsAcceptedAt).toBeNull();
      expect(user.lastLogin).toBeNull();
    });

    it('should update user fields', async () => {
      const user = await testPrisma.user.create({ 
        data: createUserData() 
      });

      // Wait a small amount to ensure updatedAt timestamp differs
      await new Promise(resolve => setTimeout(resolve, 10));

      const now = new Date();
      const updated = await testPrisma.user.update({
        where: { id: user.id },
        data: {
          name: 'Updated Name',
          isActive: false,
          termsAcceptedAt: now,
          lastLogin: now
        }
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.isActive).toBe(false);
      expect(updated.termsAcceptedAt).toEqual(now);
      expect(updated.lastLogin).toEqual(now);
      expect(updated.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
    });

    it('should find users by various criteria', async () => {
      const users = [
        createUserData({ email: 'user1@example.com', domain: 'example.com' }),
        createUserData({ email: 'user2@test.org', domain: 'test.org', provider: 'github', providerId: 'github_123' }),
        createUserData({ email: 'admin@example.com', domain: 'example.com', isAdmin: true, provider: 'google', providerId: 'google_admin' })
      ];

      await Promise.all(users.map(userData => 
        testPrisma.user.create({ data: userData })
      ));

      // Find by domain
      const exampleComUsers = await testPrisma.user.findMany({
        where: { domain: 'example.com' }
      });
      expect(exampleComUsers).toHaveLength(2);

      // Find by provider
      const googleUsers = await testPrisma.user.findMany({
        where: { provider: 'google' }
      });
      expect(googleUsers).toHaveLength(2);

      // Find admins
      const admins = await testPrisma.user.findMany({
        where: { isAdmin: true }
      });
      expect(admins).toHaveLength(1);
      expect(admins[0].email).toBe('admin@example.com');
    });
  });

  describe('Database Transactions', () => {
    it('should handle successful transactions', async () => {
      const result = await testPrisma.$transaction(async (tx) => {
        const helloWorld = await tx.helloWorld.create({
          data: { message: 'Transaction test' }
        });

        const user = await tx.user.create({
          data: {
            email: 'transaction@example.com',
            provider: 'google',
            providerId: 'google_transaction',
            domain: 'example.com'
          }
        });

        return { helloWorld, user };
      });

      expect(result.helloWorld.id).toBeDefined();
      expect(result.user.id).toBeDefined();

      // Verify both records exist
      const helloWorld = await testPrisma.helloWorld.findUnique({
        where: { id: result.helloWorld.id }
      });
      const user = await testPrisma.user.findUnique({
        where: { id: result.user.id }
      });

      expect(helloWorld).toBeDefined();
      expect(user).toBeDefined();
    });

    it('should rollback failed transactions', async () => {
      await expect(
        testPrisma.$transaction(async (tx) => {
          // Create a valid user first
          await tx.user.create({
            data: createUserData({ email: 'transaction-rollback@example.com' })
          });

          // Then try to create a duplicate (should fail)
          await tx.user.create({
            data: createUserData({ email: 'transaction-rollback@example.com' })
          });
        })
      ).rejects.toThrow();

      // Verify no users were created due to rollback
      const users = await testPrisma.user.findMany({
        where: { email: 'transaction-rollback@example.com' }
      });
      expect(users).toHaveLength(0);
    });
  });

  describe('Performance & Query Optimization', () => {
    it('should handle bulk operations efficiently', async () => {
      const startTime = Date.now();
      
      // Create 100 HelloWorld records
      const data = Array.from({ length: 100 }, (_, i) => ({
        message: `Bulk message ${i + 1}`
      }));

      await testPrisma.helloWorld.createMany({ data });

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete in reasonable time (less than 5 seconds)
      expect(duration).toBeLessThan(5000);

      // Verify all records were created
      const count = await testPrisma.helloWorld.count();
      expect(count).toBe(100);
    });

    it('should handle complex queries', async () => {
      // Create test data
      await Promise.all([
        testPrisma.user.create({ 
          data: { 
            email: 'active@example.com', 
            isActive: true, 
            domain: 'example.com',
            provider: 'google',
            providerId: 'google_active'
          } 
        }),
        testPrisma.user.create({ 
          data: { 
            email: 'inactive@example.com', 
            isActive: false, 
            domain: 'example.com',
            provider: 'google',
            providerId: 'google_inactive'
          } 
        }),
        testPrisma.user.create({ 
          data: { 
            email: 'other@test.org', 
            isActive: true, 
            domain: 'test.org',
            provider: 'github',
            providerId: 'github_other'
          } 
        })
      ]);

      const result = await testPrisma.user.findMany({
        where: {
          AND: [
            { isActive: true },
            { domain: 'example.com' }
          ]
        },
        select: {
          id: true,
          email: true,
          isActive: true,
          domain: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      });

      expect(result).toHaveLength(1);
      expect(result[0].email).toBe('active@example.com');
      expect(result[0].isActive).toBe(true);
      expect(result[0].domain).toBe('example.com');
    });
  });
});