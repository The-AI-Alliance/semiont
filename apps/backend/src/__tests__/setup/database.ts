import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class DatabaseTestSetup {
  private static container: StartedPostgreSqlContainer;
  private static prisma: PrismaClient;
  private static connectionString: string;

  static async setup() {
    console.log('🐳 Starting PostgreSQL test container...');
    
    // Configure Testcontainers to reduce risk of Node.js crashes
    // Disable ryuk (resource reaper) which can cause issues with ssh2 module
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    
    // Start PostgreSQL container aligned with environments/test.json
    this.container = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('semiont_test')  // Matches config: name: 'semiont_test'
      .withUsername('test_user')     // Matches config: user: 'test_user'
      .withPassword('test_password') // From environment variable
      .withExposedPorts(5432)
      .withEnvironment({ 
        POSTGRES_INITDB_ARGS: '--auth-host=md5' 
      })
      .withReuse() // Allow container reuse to reduce setup time
      .start();

    this.connectionString = this.container.getConnectionUri();
    console.log(`📡 Database container started: ${this.connectionString}`);
    
    // Set DATABASE_URL globally for all tests and server startup
    process.env.DATABASE_URL = this.connectionString;
    
    // Create Prisma client with test database
    this.prisma = new PrismaClient({
      datasources: {
        db: {
          url: this.connectionString,
        },
      },
      log: ['error', 'warn'], // Reduce log noise in tests
    });

    // Apply database schema using Prisma
    console.log('🔧 Applying database schema...');
    try {
      
      // Run Prisma db push to create tables
      const schemaPath = path.resolve(__dirname, '../../../prisma/schema.prisma');
      execSync(`npx prisma db push --schema="${schemaPath}" --accept-data-loss`, {
        stdio: 'pipe', // Suppress output unless there's an error
        env: { ...process.env, DATABASE_URL: this.connectionString }
      });
      
      // Generate Prisma client for test database
      execSync(`npx prisma generate --schema="${schemaPath}"`, {
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: this.connectionString }
      });
      
      console.log('✅ Database schema applied successfully');
    } catch (error) {
      console.error('❌ Failed to apply database schema:', error);
      throw error;
    }

    // Test the connection
    await this.prisma.$connect();
    console.log('🔌 Database connection established');
    
    return { 
      prisma: this.prisma, 
      connectionString: this.connectionString,
      container: this.container 
    };
  }

  static async teardown() {
    console.log('🧹 Cleaning up test database...');
    
    if (this.prisma) {
      await this.prisma.$disconnect();
      console.log('🔌 Database connection closed');
    }
    
    if (this.container) {
      await this.container.stop();
      console.log('🐳 PostgreSQL container stopped');
    }
    
    // Clean up environment
    delete process.env.DATABASE_URL;
  }

  static getPrisma() {
    if (!this.prisma) {
      throw new Error('Database not initialized. Call DatabaseTestSetup.setup() first.');
    }
    return this.prisma;
  }

  static getConnectionString() {
    if (!this.connectionString) {
      throw new Error('Database not initialized. Call DatabaseTestSetup.setup() first.');
    }
    return this.connectionString;
  }

  static async cleanDatabase() {
    if (!this.prisma) return;
    
    // Clean up all tables in reverse dependency order
    console.log('🧽 Cleaning database tables...');
    
    try {
      // Delete in order that respects foreign key constraints
      await this.prisma.user.deleteMany();
      // await this.prisma.helloWorld.deleteMany(); // helloWorld model doesn't exist
      console.log('✅ Database tables cleaned');
    } catch (error) {
      console.warn('⚠️  Warning: Failed to clean some tables:', error);
      // Don't throw - tests might still work
    }
  }
}