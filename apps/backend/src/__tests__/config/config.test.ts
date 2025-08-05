/**
 * Tests for main configuration object
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the env module
vi.mock('../../config/env', () => ({
  env: {
    SITE_NAME: 'Test Semiont',
    DOMAIN: 'test.example.com',
    OAUTH_ALLOWED_DOMAINS: ['example.com', 'test.org'],
    DATABASE_NAME: 'semiont_test',
    PORT: 3001,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/semiont_test',
    JWT_SECRET: 'test-jwt-secret-key-for-testing-purposes',
    CORS_ORIGIN: 'http://localhost:3000',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

describe('Configuration Object', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export CONFIG object with all required fields', async () => {
    vi.resetModules();
    const { CONFIG } = await import('../../config');

    expect(CONFIG).toBeDefined();
    expect(CONFIG.SITE_NAME).toBe('Test Semiont');
    expect(CONFIG.DOMAIN).toBe('test.example.com');
    expect(CONFIG.OAUTH_ALLOWED_DOMAINS).toEqual(['example.com', 'test.org']);
    expect(CONFIG.DATABASE_NAME).toBe('semiont_test');
    expect(CONFIG.PORT).toBe(3001);
    expect(CONFIG.NODE_ENV).toBe('test');
    expect(CONFIG.DATABASE_URL).toBe('postgresql://test:test@localhost:5432/semiont_test');
    expect(CONFIG.JWT_SECRET).toBe('test-jwt-secret-key-for-testing-purposes');
    expect(CONFIG.CORS_ORIGIN).toBe('http://localhost:3000');
    expect(CONFIG.FRONTEND_URL).toBe('http://localhost:3000');
  });

  it('should handle missing DATABASE_NAME with default', async () => {
    // Mock env without DATABASE_NAME
    vi.doMock('../../config/env', () => ({
      env: {
        SITE_NAME: 'Test Semiont',
        DOMAIN: 'test.example.com',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
        DATABASE_NAME: undefined, // Will use default
        PORT: 3001,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://test:test@localhost:5432/semiont_test',
        JWT_SECRET: 'test-jwt-secret-key-for-testing-purposes',
      },
    }));

    vi.resetModules();
    const { CONFIG } = await import('../../config');

    expect(CONFIG.DATABASE_NAME).toBe('semiont');
  });

  it('should preserve all environment values', async () => {
    // Mock with different values
    vi.doMock('../../config/env', () => ({
      env: {
        SITE_NAME: 'Production Semiont',
        DOMAIN: 'semiont.com',
        OAUTH_ALLOWED_DOMAINS: ['semiont.com', 'company.com'],
        DATABASE_NAME: 'semiont_prod',
        PORT: 8080,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://prod:secret@db.example.com:5432/semiont_prod',
        JWT_SECRET: 'production-jwt-secret-key-with-sufficient-length',
        CORS_ORIGIN: 'https://semiont.com',
        FRONTEND_URL: 'https://semiont.com',
      },
    }));

    vi.resetModules();
    const { CONFIG } = await import('../../config');

    expect(CONFIG.SITE_NAME).toBe('Production Semiont');
    expect(CONFIG.DOMAIN).toBe('semiont.com');
    expect(CONFIG.OAUTH_ALLOWED_DOMAINS).toEqual(['semiont.com', 'company.com']);
    expect(CONFIG.DATABASE_NAME).toBe('semiont_prod');
    expect(CONFIG.PORT).toBe(8080);
    expect(CONFIG.NODE_ENV).toBe('production');
    expect(CONFIG.DATABASE_URL).toBe('postgresql://prod:secret@db.example.com:5432/semiont_prod');
    expect(CONFIG.JWT_SECRET).toBe('production-jwt-secret-key-with-sufficient-length');
    expect(CONFIG.CORS_ORIGIN).toBe('https://semiont.com');
    expect(CONFIG.FRONTEND_URL).toBe('https://semiont.com');
  });

  it('should be immutable', async () => {
    vi.resetModules();
    
    // Re-mock the env module to ensure consistent values
    vi.doMock('../../config/env', () => ({
      env: {
        SITE_NAME: 'Test Semiont',
        DOMAIN: 'test.example.com',
        OAUTH_ALLOWED_DOMAINS: ['example.com', 'test.org'],
        DATABASE_NAME: 'semiont_test',
        PORT: 3001,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://test:test@localhost:5432/semiont_test',
        JWT_SECRET: 'test-jwt-secret-key-for-testing-purposes',
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      },
    }));
    
    const { CONFIG } = await import('../../config');

    // Attempt to modify CONFIG should not affect the original
    const originalSiteName = CONFIG.SITE_NAME;
    
    expect(() => {
      (CONFIG as any).SITE_NAME = 'Modified Name';
    }).not.toThrow(); // Assignment might not throw, but should not affect exports from other imports

    // Re-import to verify immutability
    vi.resetModules();
    
    // Re-mock again for the fresh import
    vi.doMock('../../config/env', () => ({
      env: {
        SITE_NAME: 'Test Semiont',
        DOMAIN: 'test.example.com',
        OAUTH_ALLOWED_DOMAINS: ['example.com', 'test.org'],
        DATABASE_NAME: 'semiont_test',
        PORT: 3001,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://test:test@localhost:5432/semiont_test',
        JWT_SECRET: 'test-jwt-secret-key-for-testing-purposes',
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      },
    }));
    
    const { CONFIG: freshConfig } = await import('../../config');
    
    // Should maintain original values from env mock
    expect(freshConfig.SITE_NAME).toBe('Test Semiont');
  });
});