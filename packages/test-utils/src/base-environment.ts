/**
 * Base test environment class with common functionality
 * 
 * Provides shared utilities for all test environments
 */

import { vi } from 'vitest';

export abstract class TestEnvironmentBase {
  protected originalEnv: NodeJS.ProcessEnv;
  protected originalCwd: string;
  protected isInitialized = false;

  constructor() {
    // Store original state
    this.originalEnv = { ...process.env };
    this.originalCwd = process.cwd();
  }

  /**
   * Initialize the test environment
   */
  abstract initialize(options?: any): Promise<void>;

  /**
   * Reset mocks but keep environment
   */
  abstract resetMocks(): void;

  /**
   * Full reset - restore original state
   */
  abstract reset(): Promise<void>;

  /**
   * Clean up everything
   */
  abstract cleanup(): Promise<void>;

  /**
   * Set environment variables
   */
  setEnvVars(vars: Record<string, string | undefined>): void {
    Object.entries(vars).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }

  /**
   * Set a single environment variable
   */
  setEnvVar(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  /**
   * Restore original environment variables
   */
  protected restoreEnvironment(): void {
    process.env = { ...this.originalEnv };
  }

  /**
   * Restore original working directory
   */
  protected restoreWorkingDirectory(): void {
    try {
      process.chdir(this.originalCwd);
    } catch (error) {
      console.warn('Failed to restore working directory:', error);
    }
  }

  /**
   * Mock a module with lazy loading
   */
  protected mockModule(modulePath: string, factory: () => any): void {
    vi.doMock(modulePath, factory);
  }

  /**
   * Unmock a module
   */
  protected unmockModule(modulePath: string): void {
    vi.unmock(modulePath);
  }

  /**
   * Clear all mocks
   */
  protected clearAllMocks(): void {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  }

  /**
   * Get initialization status
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Wait for initialization with timeout
   */
  async waitForReady(timeoutMs: number = 5000): Promise<void> {
    const startTime = Date.now();
    
    while (!this.isInitialized) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Test environment initialization timeout');
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Run a function with temporary environment variables
   */
  async withEnv<T>(
    vars: Record<string, string | undefined>,
    fn: () => T | Promise<T>
  ): Promise<T> {
    const originalVars: Record<string, string | undefined> = {};
    
    // Store original values
    Object.keys(vars).forEach(key => {
      originalVars[key] = process.env[key];
    });
    
    try {
      // Set new values
      this.setEnvVars(vars);
      
      // Run function
      return await fn();
    } finally {
      // Restore original values
      this.setEnvVars(originalVars);
    }
  }

  /**
   * Run a function in a different directory
   */
  async inDirectory<T>(
    dir: string,
    fn: () => T | Promise<T>
  ): Promise<T> {
    const originalDir = process.cwd();
    
    try {
      process.chdir(dir);
      return await fn();
    } finally {
      process.chdir(originalDir);
    }
  }
}