import { PrismaClient } from '@prisma/client';
import { getLogger } from './logger';

// Lazy initialization to avoid calling getLogger() at module load time
const getDBLogger = () => getLogger().child({ component: 'database' });

const globalForPrisma = global as unknown as { prisma: PrismaClient | undefined };

/**
 * Database connection manager with lazy initialization
 * 
 * Usage:
 *   const prisma = DatabaseConnection.getClient();
 *   const user = await prisma.user.findUnique({ where: { id } });
 */
export class DatabaseConnection {
  private static instance: PrismaClient | null = null;
  private static isInitializing = false;
  
  /**
   * Get or create the Prisma client instance
   * Lazy loads the connection on first use
   */
  static getClient(): PrismaClient {
    // Check if we already have an instance (either global or local)
    if (globalForPrisma.prisma) {
      return globalForPrisma.prisma;
    }
    
    if (this.instance) {
      return this.instance;
    }
    
    // Prevent multiple simultaneous initializations
    if (this.isInitializing) {
      throw new Error('Database connection is already being initialized');
    }
    
    this.isInitializing = true;
    try {
      // Determine log level based on environment
      const logLevel = this.getLogLevel();
      
      // Create new PrismaClient instance
      this.instance = new PrismaClient({
        log: logLevel,
      });
      
      // In non-production, store in global for hot-reload persistence
      if (process.env.NODE_ENV !== 'production') {
        globalForPrisma.prisma = this.instance;
      }
      
      return this.instance;
    } finally {
      this.isInitializing = false;
    }
  }
  
  /**
   * Get appropriate log level based on environment
   */
  private static getLogLevel(): Array<'query' | 'error' | 'warn' | 'info'> {
    const env = process.env.NODE_ENV;
    
    if (env === 'development') {
      return ['query', 'error', 'warn'];
    }
    
    // Default to error-only logging for production and test
    return ['error'];
  }
  
  /**
   * Override the Prisma client instance (useful for testing)
   */
  static setClient(client: PrismaClient): void {
    this.instance = client;
    // Also update global if in non-production
    if (process.env.NODE_ENV !== 'production') {
      globalForPrisma.prisma = client;
    }
  }
  
  /**
   * Reset the connection (useful for testing)
   * This will close the existing connection and clear the instance
   */
  static async reset(): Promise<void> {
    if (this.instance) {
      if (typeof this.instance.$disconnect === 'function') {
        await this.instance.$disconnect();
      }
      this.instance = null;
    }
    
    if (globalForPrisma.prisma) {
      if (typeof globalForPrisma.prisma.$disconnect === 'function') {
        await globalForPrisma.prisma.$disconnect();
      }
      globalForPrisma.prisma = undefined;
    }
  }
  
  /**
   * Disconnect from the database
   * Useful for graceful shutdown
   */
  static async disconnect(): Promise<void> {
    const client = this.instance || globalForPrisma.prisma;
    if (client) {
      await client.$disconnect();
    }
  }
  
  /**
   * Check database health by attempting a simple query
   * Returns true if connected, false otherwise
   */
  static async checkHealth(): Promise<boolean> {
    try {
      const client = this.getClient();
      // Simple query to check connection
      await client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      getDBLogger().error('Database health check failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return false;
    }
  }
}

// For convenience, export a getter function
export function getDatabase(): PrismaClient {
  return DatabaseConnection.getClient();
}

// Export prisma for tests
export const prisma = DatabaseConnection.getClient();