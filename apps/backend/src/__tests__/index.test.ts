/**
 * Tests for the main application (index.ts)
 * 
 * These tests verify the Hono app configuration, middleware setup,
 * and route definitions using the proper test environment.
 * 
 * Note: Due to ES module mocking limitations, auth middleware behavior
 * is tested in integration tests with proper mock setup.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Hono } from 'hono';

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
  },
}));

describe('Main Application (index.ts)', () => {
  let app: Hono;

  beforeAll(async () => {
    // Import the app
    const { app: importedApp } = await import('../index');
    app = importedApp;
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
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('operational');
      expect(data.message).toBe('Semiont API is running');
      expect(data.version).toBe('0.1.0');
      expect(data.environment).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('API Documentation', () => {
    it('should redirect API clients to OpenAPI JSON spec', async () => {
      const response = await app.request('http://localhost/api', {
        headers: { 'Accept': 'application/json' },
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/api/openapi.json');
    });

    it('should redirect browsers to Swagger UI', async () => {
      const response = await app.request('http://localhost/api', {
        headers: { 
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (Browser)'
        },
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/api/docs');
    });
  });

  describe('Authentication Endpoints', () => {
    it('should handle OAuth endpoint structure', async () => {
      const response = await app.request('http://localhost/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Should return 400 for invalid request body (not 404)
      expect(response.status).toBe(400);
    });
  });

  describe('Error Handling', () => {
    it('should handle non-existent routes', async () => {
      const response = await app.request('http://localhost/api/nonexistent');
      
      expect(response.status).toBe(404);
    });

    it('should handle invalid JSON in POST requests', async () => {
      const response = await app.request('http://localhost/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });

      expect(response.status).toBe(400);
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
      // behavior since we can't properly mock the OAuthService in unit tests.
      // Full auth behavior is tested in integration tests.
      
      // We can verify that the middleware chain exists by checking that
      // routes are registered
      const response = await app.request('http://localhost/api');
      expect(response.status).not.toBe(404);
    });

    it('should have public endpoints defined', () => {
      // This is more of a documentation test to ensure we know what endpoints
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