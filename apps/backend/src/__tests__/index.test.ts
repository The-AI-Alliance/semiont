/**
 * Tests for the main application (index.ts)
 * 
 * These tests verify the Hono app configuration, middleware setup,
 * and route definitions using the proper test environment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Main Application (index.ts)', () => {
  let app: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Import the app - this should work with SEMIONT_ENV=test
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
      const response = await app.request('http://localhost/api/status', {
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
    it('should return hello message', async () => {
      const response = await app.request('http://localhost/api/hello');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.message).toContain('Hello');
      expect(data.message).toContain('Semiont');
      expect(data.platform).toBe('Semiont Semantic Knowledge Platform');
      expect(data.timestamp).toBeDefined();
    });

    it('should return service status', async () => {
      const response = await app.request('http://localhost/api/status');
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('operational');
      expect(data.version).toBe('0.1.0');
      expect(data.features).toEqual({
        semanticContent: 'planned',
        collaboration: 'planned',
        rbac: 'planned',
      });
    });

    it('should return health status', async () => {
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
    it('should return JSON documentation for API clients', async () => {
      const response = await app.request('http://localhost/api', {
        headers: { 'Accept': 'application/json' },
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.name).toBe('Semiont API');
      expect(data.version).toBe('0.1.0');
      expect(data.endpoints).toBeDefined();
      expect(data.endpoints.public).toBeDefined();
      expect(data.endpoints.auth).toBeDefined();
      expect(data.endpoints.admin).toBeDefined();
    });

    it('should return HTML documentation for browsers', async () => {
      const response = await app.request('http://localhost/api', {
        headers: { 
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (Browser)'
        },
      });

      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Semiont API Documentation');
    });
  });

  describe('Authentication Endpoints', () => {
    it('should handle auth endpoints', async () => {
      // Test that auth endpoints exist and require authentication
      const response = await app.request('http://localhost/api/auth/me');
      
      // Should return 401 without auth header
      expect(response.status).toBe(401);
    });

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

  describe('Admin Endpoints', () => {
    it('should require admin authentication', async () => {
      const response = await app.request('http://localhost/api/admin/users');
      
      // Should return 401 for missing authentication
      expect(response.status).toBe(401);
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
    it('should export app for testing', async () => {
      const { app: exportedApp } = await import('../index');
      expect(exportedApp).toBeDefined();
      expect(typeof exportedApp.fetch).toBe('function');
    });
  });
});