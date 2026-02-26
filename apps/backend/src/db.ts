import { PrismaClient } from '@prisma/client';
import type { Logger } from '@semiont/core';

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
      // Determine which events to enable based on environment
      const logLevels = this.getLogLevel();

      // Create new PrismaClient instance
      // Use 'emit' type to trigger $on() handlers without stdout logging
      const logConfig = logLevels.map(level => ({ emit: 'event' as const, level }));

      this.instance = new PrismaClient({
        log: logConfig,  // Enable events but not stdout logging
      });

      // Setup custom logging to Winston (logs/combined.log)
      // Logger is retrieved lazily inside each handler to avoid initialization order issues
      this.instance.$on('query' as never, (e: any) => {
        this.getDBLogger()?.debug('Query', {
          query: e.query,
          params: e.params,
          duration: `${e.duration}ms`,
          target: e.target
        });
      });

      this.instance.$on('error' as never, (e: any) => {
        this.getDBLogger()?.error('Database error', {
          message: e.message,
          target: e.target
        });
      });

      this.instance.$on('warn' as never, (e: any) => {
        this.getDBLogger()?.warn('Database warning', {
          message: e.message,
          target: e.target
        });
      });

      this.instance.$on('info' as never, (e: any) => {
        this.getDBLogger()?.info('Database info', {
          message: e.message,
          target: e.target
        });
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
   * These events are captured by $on() handlers and routed to Winston
   */
  private static getLogLevel(): Array<'query' | 'error' | 'warn' | 'info'> {
    const env = process.env.NODE_ENV;

    if (env === 'development') {
      // Enable query logging in development (goes to logs/combined.log via Winston)
      return ['query', 'error', 'warn', 'info'];
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
   * Get database logger safely (returns null if logger not initialized)
   * This avoids initialization order issues
   */
  private static getDBLogger(): Logger | null {
    try {
      // Dynamic import to avoid circular dependency
      const { getLogger } = require('./logger');
      return getLogger().child({ component: 'database' });
    } catch (error) {
      // Logger not initialized yet - return null and log events will be skipped
      return null;
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
      this.getDBLogger()?.error('Database health check failed', {
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