/**
 * Tests for environment configuration loading and validation
 * 
 * These tests verify that our environment configuration system works correctly
 * and validates configurations properly. Instead of hardcoded values, we use
 * our actual environment configurations as the source of truth.
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
    it('should load and validate valid development configuration', async () => {
      const validConfig = {
        NODE_ENV: 'development',
        PORT: 3001,
        DATABASE_URL: 'postgresql://dev_user:dev_password@localhost:5432/semiont_dev',
        DATABASE_NAME: 'semiont_dev',
        JWT_SECRET: 'development-jwt-secret-key-min-32-characters-long',
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['localhost', 'example.com'],
      };

      mockLoadBackendConfig.mockReturnValue(validConfig);
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

    it('should handle unit test environment', async () => {
      const unitTestConfig = {
        NODE_ENV: 'test',
        PORT: 3001,
        // Unit tests use mock database URL
        DATABASE_URL: 'postgresql://mock_user:mock_password@mock-host:5432/mock_unit_test_db',
        DATABASE_NAME: 'mock_unit_test_db',
        JWT_SECRET: 'unit-test-jwt-secret-key-for-testing-environment',
        SITE_NAME: 'Semiont Unit Tests',
        DOMAIN: 'test.example.com',
        OAUTH_ALLOWED_DOMAINS: ['test.example.com', 'example.org'],
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      };

      mockLoadBackendConfig.mockReturnValue(unitTestConfig);
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env.NODE_ENV).toBe('test');
      expect(env.DATABASE_NAME).toBe('mock_unit_test_db');
      expect(env.DOMAIN).toBe('test.example.com');
    });

    it('should handle integration test environment', async () => {
      const integrationTestConfig = {
        NODE_ENV: 'test',
        PORT: 3001,
        // Integration tests use Testcontainers (URL will be dynamic)
        DATABASE_URL: 'postgresql://integration_test_user:integration_test_password@testcontainer-host:5432/semiont_integration_test',
        DATABASE_NAME: 'semiont_integration_test',
        JWT_SECRET: 'integration-test-jwt-secret-key-for-testing-environment',
        SITE_NAME: 'Semiont Integration Tests',
        DOMAIN: 'test.example.com',
        OAUTH_ALLOWED_DOMAINS: ['test.example.com', 'example.org'],
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      };

      mockLoadBackendConfig.mockReturnValue(integrationTestConfig);
      vi.resetModules();
      
      const { env } = await import('../../config/env');

      expect(env.NODE_ENV).toBe('test');
      expect(env.DATABASE_NAME).toBe('semiont_integration_test');
    });
  });

  describe('Invalid Configuration', () => {
    it('should throw error for invalid NODE_ENV', async () => {
      const invalidConfig = {
        NODE_ENV: 'invalid',
        PORT: 3001,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      await expect(async () => {
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
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      await expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });

    it('should throw error for invalid DATABASE_URL', async () => {
      const invalidConfig = {
        NODE_ENV: 'development',
        PORT: 3001,
        DATABASE_URL: 'invalid-url', // Invalid URL
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      await expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });

    it('should throw error for short JWT_SECRET', async () => {
      const invalidConfig = {
        NODE_ENV: 'development',
        PORT: 3001,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'short', // Too short
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
        CORS_ORIGIN: 'http://localhost:3000',
        FRONTEND_URL: 'http://localhost:3000',
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      await expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });

    it('should throw error for invalid CORS_ORIGIN', async () => {
      const invalidConfig = {
        NODE_ENV: 'development',
        PORT: 3001,
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/semiont',
        DATABASE_NAME: 'semiont',
        JWT_SECRET: 'valid-jwt-secret-key-for-testing-purposes',
        SITE_NAME: 'Semiont',
        DOMAIN: 'localhost',
        OAUTH_ALLOWED_DOMAINS: ['example.com'],
        CORS_ORIGIN: 'invalid-url', // Invalid URL
        FRONTEND_URL: 'http://localhost:3000',
      };

      mockLoadBackendConfig.mockReturnValue(invalidConfig);
      vi.resetModules();

      await expect(async () => {
        await import('../../config/env');
      }).rejects.toThrow();
    });
  });
});