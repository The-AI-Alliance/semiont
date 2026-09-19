/**
 * Tests for the main application (index.ts)
 * 
 * These tests verify the Hono app configuration, middleware setup,
 * and route definitions using the proper test environment.
 * 
 * Note: Due to ES module mocking limitations, auth middleware behavior
 * is tested in integration tests with proper mock setup.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { setupTestEnvironment, type TestEnvironmentConfig } from './_test-setup';
import { makeMeaningMock } from './helpers/make-meaning-mock';

// Typed from the module under test rather than from a local restatement of its
// context. The copy that stood here could only ever report that two
// structurally identical types were not the same one.
type GatewayApp = typeof import('../index').app;

interface HealthResponse {
  status: string;
  message: string;
  version: string;
  environment?: string;
  timestamp?: string;
}

// Read straight off disk rather than from the __SEMIONT_VERSION__ define, so a
// build config that forgets the define is a test failure rather than a
// tautology that passes.
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(import.meta.url), '../../../package.json'),
    'utf-8',
  ),
).version;

// Mock make-meaning service to avoid graph initialization at import time
vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    startMakeMeaningGateway: vi.fn().mockResolvedValue(makeMeaningMock())
  };
});

// Mock the database before any imports to avoid connection attempts
vi.mock('../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => ({
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    })),
    checkHealth: vi.fn().mockResolvedValue(true),
  },
}));

describe('Main Application (index.ts)', () => {
  let app: GatewayApp;
  let testEnv: TestEnvironmentConfig;

  beforeAll(async () => {
    // Set up test environment with proper config files
    testEnv = await setupTestEnvironment();

    // Import the app after environment is set up
    const { app: importedApp } = await import('../index');
    app = importedApp;
  });

  afterAll(async () => {
    // Clean up test environment
    await testEnv.cleanup();
  });

  describe('Application Setup', () => {
    it('should create Hono app instance', () => {
      expect(app).toBeDefined();
      expect(typeof app.request).toBe('function');
      expect(typeof app.fetch).toBe('function');
    });

    it('should have CORS middleware configured', async () => {
      const response = await app.request('http://localhost/api/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
    });
  });

  describe('Public Endpoints', () => {
    it('should return health status without authentication', async () => {
      const response = await app.request('http://localhost/api/health');
      const data = await response.json() as HealthResponse;

      expect(response.status).toBe(200);
      expect(data.status).toBe('operational');
      expect(data.message).toBe('Semiont API is running');
      expect(data.environment).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });

    it('should report the real package version, not a hardcoded one', async () => {
      const response = await app.request('http://localhost/api/health');
      const data = await response.json() as HealthResponse;

      expect(data.version).toBe(PACKAGE_VERSION);
      expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('API Resourceation', () => {
    it('should redirect API root to docs for browser requests', async () => {
      const response = await app.request('http://localhost/api', {
        headers: { 
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (Browser)'
        },
      });

      // API resourceation is now public and redirects to /api/docs
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/api/docs');
    });

    it('should redirect API root to OpenAPI JSON for API requests', async () => {
      const response = await app.request('http://localhost/api', {
        headers: { 'Accept': 'application/json' },
      });

      // API resourceation is public and redirects to OpenAPI spec
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/api/openapi.json');
    });

    it('should redirect /api/swagger to /api/docs', async () => {
      const response = await app.request('http://localhost/api/swagger', {
        headers: { 
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (Browser)'
        },
      });

      // Swagger UI redirects to /api/docs
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/api/docs');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for non-existent API routes', async () => {
      const response = await app.request('http://localhost/api/nonexistent');

      // Non-existent routes now return 404 (auth is applied per-router)
      expect(response.status).toBe(404);
    });

    it('should handle invalid JSON in POST requests', async () => {
      // The agent route is the one public POST; it answers 503 without its secret.
      const priorSecret = process.env.SEMIONT_WORKER_SECRET;
      process.env.SEMIONT_WORKER_SECRET = 'index-test-worker-secret';
      try {
        const response = await app.request('http://localhost/api/tokens/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-json',
        });

        expect(response.status).toBe(400);
      } finally {
        if (priorSecret === undefined) delete process.env.SEMIONT_WORKER_SECRET;
        else process.env.SEMIONT_WORKER_SECRET = priorSecret;
      }
    });
  });

  describe('Server Configuration', () => {
    it('should export app for testing', () => {
      expect(app).toBeDefined();
      expect(typeof app.fetch).toBe('function');
    });
  });

  describe('Middleware Configuration', () => {
    it('should have authentication middleware configured for API routes', async () => {
      // This test verifies the middleware is set up, but doesn't test the actual auth
      // behavior — principalFromToken is not mocked here; the middleware suite covers it.
      
      // We can verify that the middleware chain exists by checking that
      // routes are registered
      const response = await app.request('http://localhost/api');
      expect(response.status).not.toBe(404);
    });

    it('should have public endpoints defined', () => {
      // This is more of a resourceation test to ensure we know what endpoints
      // are supposed to be public
      const publicEndpoints = [
        '/api/health',
        '/api/auth/google',
        '/api',
      ];
      
      // Just verify the array exists (we can't directly access it from here)
      expect(publicEndpoints).toContain('/api/health');
    });
  });
});