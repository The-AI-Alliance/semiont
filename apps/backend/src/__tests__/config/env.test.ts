/**
 * Tests for environment configuration loading and validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the loader module before importing env
vi.mock('../../config/loader', () => ({
  loadBackendConfig: vi.fn(),
}));

describe('Environment Configuration', () => {
  let mockLoadBackendConfig: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { loadBackendConfig } = await import('../../config/loader');
    mockLoadBackendConfig = vi.mocked(loadBackendConfig);
  });

  describe('Valid Configuration', () => {
    it('should load and validate valid configuration', async () => {
      const validConfig = {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'a-very-long-jwt-secret-key-for-testing-purposes',
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com', 'test.org'],
      };

      mockLoadBackendConfig.mockReturnValue(validConfig);

      // Clear the module cache to force re-evaluation
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env).toEqual(validConfig);
      expect(mockLoadBackendConfig).toHaveBeenCalledOnce();
    });

    it('should handle production environment', async () => {
      const prodConfig = {
        NODE_ENV: 'production',
        PORT: 8080,
        DATABASE_URL: 'postgresql://prod-user:prod-pass@prod-host:5432/semiont',
        DATABASE_NAME: 'semiont_prod',
        JWT_SECRET: 'production-jwt-secret-key-with-sufficient-length',
        CORS_ORIGIN: 'https://example.com',
        FRONTEND_URL: 'https://example.com',
        SITE_NAME: 'Semiont Production',
        DOMAIN: 'example.com',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(prodConfig);
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env.NODE_ENV).toBe('production');
      expect(env.PORT).toBe(8080);
      expect(env.DOMAIN).toBe('example.com');
    });

    it('should handle test environment', async () => {
      const testConfig = {
        NODE_ENV: 'test',
        PORT: 3001,
        DATABASE_URL: 'postgresql://test:test@localhost:5432/semiont_test',
        DATABASE_NAME: 'semiont_test',
        JWT_SECRET: 'test-jwt-secret-key-for-testing-environment',
        SITE_NAME: 'Semiont Test',
        DOMAIN: 'test.localhost',
        OAUTH_ALLOWED_DOMAINS: ['test.com'],
      };

      mockLoadBackendConfig.mockReturnValue(testConfig);
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env.NODE_ENV).toBe('test');
      expect(env.DATABASE_NAME).toBe('semiont_test');
    });
  });

  describe('Invalid Configuration', () => {
    it('should throw error for invalid NODE_ENV', async () => {
      const invalidConfig = {
        NODE_ENV: 'invalid',
        PORT: 3000,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });

    it('should throw error for invalid PORT', async () => {
      const invalidConfig = {
        NODE_ENV: 'development',
        PORT: 0, // Invalid port
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });

    it('should throw error for invalid DATABASE_URL', async () => {
      const invalidConfig = {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'not-a-valid-url',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });

    it('should throw error for short JWT_SECRET', async () => {
      const invalidConfig = {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'short', // Too short
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });

    it('should throw error for invalid CORS_ORIGIN', async () => {
      const invalidConfig = {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        CORS_ORIGIN: 'not-a-valid-url',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });
  });

  describe('Optional Fields', () => {
    it('should handle missing optional fields', async () => {
      const configWithoutOptionals = {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
        // CORS_ORIGIN and FRONTEND_URL omitted
      };

      mockLoadBackendConfig.mockReturnValue(configWithoutOptionals);
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env.CORS_ORIGIN).toBeUndefined();
      expect(env.FRONTEND_URL).toBeUndefined();
      expect(env.NODE_ENV).toBe('development');
    });
  });

  describe('OAuth Configuration', () => {
    it('should handle multiple allowed domains', async () => {
      const configWithMultipleDomains = {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com', 'test.org', 'company.co.uk'],
      };

      mockLoadBackendConfig.mockReturnValue(configWithMultipleDomains);
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env.OAUTH_ALLOWED_DOMAINS).toEqual(['example.com', 'test.org', 'company.co.uk']);
    });

    it('should handle single allowed domain', async () => {
      const configWithSingleDomain = {
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(configWithSingleDomain);
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env.OAUTH_ALLOWED_DOMAINS).toEqual(['example.com']);
    });
  });
});