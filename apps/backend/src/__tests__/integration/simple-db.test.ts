import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import path from 'path';

describe('Simple Database Integration Test', () => {
  let container: PostgreSqlContainer;
  let prisma: PrismaClient;
  let connectionString: string;

  beforeAll(async () => {
    console.log('🐳 Starting PostgreSQL container...');
    
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('test_semiont')
      .withUsername('test_user')
      .withPassword('test_password')
      .start();

    connectionString = container.getConnectionUri();
    console.log(`📡 Container started: ${connectionString}`);
    
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: connectionString,
        },
      },
      log: ['error'],
    });

    // Apply schema
    console.log('🔧 Applying schema...');
    process.env.DATABASE_URL = connectionString;
    
    const schemaPath = path.resolve(__dirname, '../../../prisma/schema.prisma');
    execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss`, {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: connectionString }
    });
    
    await prisma.$connect();
    console.log('✅ Database ready');
  }, 60000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
  });

  it('should connect to database', async () => {
    const result = await prisma.$queryRaw<Array<{ test: number }>>`SELECT 1 as test`;
    expect(result).toEqual([{ test: 1 }]);
  });

  it('should create and query HelloWorld record', async () => {
    const created = await prisma.helloWorld.create({
      data: { message: 'Test message' }
    });
    
    expect(created.id).toBeDefined();
    expect(created.message).toBe('Test message');
    
    const found = await prisma.helloWorld.findUnique({
      where: { id: created.id }
    });
    
    expect(found?.message).toBe('Test message');
  });

  it('should create and query User record', async () => {
    const userData = {
      email: 'test@example.com',
      provider: 'google',
      providerId: 'google_123',
      domain: 'example.com'
    };
    
    const created = await prisma.user.create({ data: userData });
    
    expect(created.id).toBeDefined();
    expect(created.email).toBe(userData.email);
    
    const found = await prisma.user.findUnique({
      where: { email: userData.email }
    });
    
    expect(found?.provider).toBe(userData.provider);
  });
});