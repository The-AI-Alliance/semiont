import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Simple Database Integration Test', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let connectionString: string;

  beforeAll(async () => {
    console.log('🐳 Starting PostgreSQL container...');
    
    container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('semiont_test')  // Matches environments/test.json
      .withUsername('test_user')
      .withPassword('test_password')
      .start();

    connectionString = container.getConnectionUri();
    console.log(`📡 Container started: ${connectionString}`);
    
    const adapter = new PrismaPg({ connectionString });
    prisma = new PrismaClient({
      adapter,
      log: ['error'],
    });

    // Apply schema
    console.log('🔧 Applying schema...');
    process.env.DATABASE_URL = connectionString;
    
    const backendRoot = path.resolve(__dirname, '../../..');
    const schemaPath = path.join(backendRoot, 'prisma/schema.prisma');
    execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss`, {
      stdio: 'pipe',
      cwd: backendRoot,
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