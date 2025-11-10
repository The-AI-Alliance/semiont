/**
 * Route Authentication Coverage Tests
 *
 * Systematically verifies that ALL backend routes require authentication
 * except for explicitly public endpoints.
 *
 * This test introspects the actual registered routes in the Hono app,
 * preventing regressions where new routes are added without auth middleware.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig } from '@semiont/core';
import { setupTestEnvironment, type TestEnvironmentConfig } from './_test-setup';

type Variables = {
  user: User;
  config: EnvironmentConfig;
};

// Routes that intentionally do NOT require authentication
const PUBLIC_ROUTES = [
  // Health check (for load balancers)
  '/api/health',

  // Authentication endpoints (login/signup)
  '/api/tokens/local',
  '/api/tokens/google',
  '/api/tokens/refresh',

  // Documentation endpoints
  '/api',
  '/api/docs',
  '/api/swagger',
  '/api/openapi.json',
] as const;

// Helper to check if a path matches a public route
function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some(publicRoute => {
    // Exact match
    if (path === publicRoute) return true;

    // For catch-all routes like /api/*, check if path starts with the prefix
    if (publicRoute.endsWith('/*') && path.startsWith(publicRoute.slice(0, -2))) {
      return true;
    }

    return false;
  });
}

// Helper to convert route pattern to testable path
function routePatternToTestPath(pattern: string): string {
  // Replace :param with test-value
  return pattern
    .replace(/:id/g, 'test-id')
    .replace(/:resourceId/g, 'test-resource-id')
    .replace(/:annotationId/g, 'test-annotation-id')
    .replace(/:token/g, 'test-token')
    .replace(/\*/g, 'wildcard');
}

describe('Route Authentication Coverage', () => {
  let app: Hono<{ Variables: Variables }>;
  let testEnv: TestEnvironmentConfig;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    const { app: importedApp } = await import('../index');
    app = importedApp;
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  describe('Public Routes', () => {
    it('should allow access to documented public endpoints without authentication', async () => {
      for (const path of PUBLIC_ROUTES) {
        const res = await app.request(path, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        // Public routes should NOT return 401 Unauthorized
        // They may return other errors (404, 400, etc.) but not 401
        expect(res.status).not.toBe(401);
      }
    });
  });

  describe('All Registered Routes - Authentication Required', () => {
    it('should reject ALL non-public routes without bearer token with 401', async () => {
      // Get all registered routes from the Hono app
      const routes = app.routes;

      const failures: Array<{ method: string; path: string; status: number; body?: any }> = [];
      const tested: Array<{ method: string; path: string }> = [];
      const skipped: Array<{ method: string; path: string; reason: string }> = [];

      for (const route of routes) {
        const method = route.method;
        const pattern = route.path;

        // Skip public routes
        if (isPublicRoute(pattern)) {
          skipped.push({ method, path: pattern, reason: 'public route' });
          continue;
        }

        // Skip catch-all 404 handlers
        if (pattern.includes('/*')) {
          skipped.push({ method, path: pattern, reason: 'catch-all handler' });
          continue;
        }

        // Convert route pattern to testable path
        const testPath = routePatternToTestPath(pattern);

        // For annotation routes that need resourceId query param
        const fullPath = testPath.includes('/annotations/') && !testPath.includes('/api/annotations/')
          ? `${testPath}?resourceId=test-resource-id`
          : testPath;

        tested.push({ method, path: pattern });

        // Test without authentication
        const res = await app.request(fullPath, {
          method,
          headers: { 'Accept': 'application/json' },
        });

        // All protected routes MUST return 401
        if (res.status !== 401) {
          let body;
          try {
            body = await res.clone().json();
          } catch {
            try {
              body = await res.text();
            } catch {
              body = '<unable to read body>';
            }
          }

          failures.push({
            method,
            path: pattern,
            status: res.status,
            body,
          });
        }
      }

      // Report results
      console.log(`\n🔍 Route Authentication Coverage:`);
      console.log(`   ✅ Tested: ${tested.length} routes`);
      console.log(`   ⏭️  Skipped: ${skipped.length} routes (public/handlers)`);
      console.log(`   ❌ Failures: ${failures.length} routes\n`);

      if (failures.length > 0) {
        console.error('❌ Routes that failed to return 401 without authentication:');
        failures.forEach(f => {
          console.error(`   ${f.method.padEnd(6)} ${f.path.padEnd(60)} -> ${f.status}`);
          if (f.body) {
            console.error(`          Response: ${JSON.stringify(f.body).substring(0, 100)}`);
          }
        });
        console.error('');
      }

      expect(failures).toEqual([]);
    });

    it('should reject ALL non-public routes with invalid bearer token with 401', async () => {
      const routes = app.routes;
      const failures: Array<{ method: string; path: string; status: number }> = [];

      for (const route of routes) {
        const method = route.method;
        const pattern = route.path;

        // Skip public routes and catch-all handlers
        if (isPublicRoute(pattern) || pattern.includes('/*')) {
          continue;
        }

        const testPath = routePatternToTestPath(pattern);
        const fullPath = testPath.includes('/annotations/') && !testPath.includes('/api/annotations/')
          ? `${testPath}?resourceId=test-resource-id`
          : testPath;

        const res = await app.request(fullPath, {
          method,
          headers: {
            'Accept': 'application/json',
            'Authorization': 'Bearer invalid-token-12345',
          },
        });

        if (res.status !== 401) {
          failures.push({
            method,
            path: pattern,
            status: res.status,
          });
        }
      }

      if (failures.length > 0) {
        console.error('❌ Routes that failed to return 401 with invalid token:');
        failures.forEach(f => {
          console.error(`   ${f.method.padEnd(6)} ${f.path.padEnd(60)} -> ${f.status}`);
        });
      }

      expect(failures).toEqual([]);
    });

    it('should reject ALL non-public routes with malformed Authorization header with 401', async () => {
      const routes = app.routes;
      const malformedHeaders = [
        'Basic dXNlcjpwYXNz',  // Wrong scheme
        'token-without-bearer',  // Missing scheme
        'Bearer',  // No token
        'Bearer   ',  // Empty token
      ];

      for (const authHeader of malformedHeaders) {
        const failures: Array<{ method: string; path: string; status: number }> = [];

        for (const route of routes) {
          const method = route.method;
          const pattern = route.path;

          if (isPublicRoute(pattern) || pattern.includes('/*')) {
            continue;
          }

          const testPath = routePatternToTestPath(pattern);
          const fullPath = testPath.includes('/annotations/') && !testPath.includes('/api/annotations/')
            ? `${testPath}?resourceId=test-resource-id`
            : testPath;

          const res = await app.request(fullPath, {
            method,
            headers: {
              'Accept': 'application/json',
              'Authorization': authHeader,
            },
          });

          if (res.status !== 401) {
            failures.push({
              method,
              path: pattern,
              status: res.status,
            });
          }
        }

        if (failures.length > 0) {
          console.error(`❌ Routes that failed to return 401 for malformed header "${authHeader}":`);
          failures.forEach(f => {
            console.error(`   ${f.method.padEnd(6)} ${f.path.padEnd(60)} -> ${f.status}`);
          });
        }

        expect(failures).toEqual([]);
      }
    });
  });

  describe('Coverage Statistics', () => {
    it('should report comprehensive coverage statistics', () => {
      const routes = app.routes;
      const publicCount = routes.filter(r => isPublicRoute(r.path)).length;
      const catchAllCount = routes.filter(r => r.path.includes('/*')).length;
      const protectedCount = routes.filter(r => !isPublicRoute(r.path) && !r.path.includes('/*')).length;
      const totalCount = routes.length;

      console.log(`\n📊 Route Security Statistics:`);
      console.log(`   Total routes: ${totalCount}`);
      console.log(`   Public routes: ${publicCount} (${Math.round(publicCount / totalCount * 100)}%)`);
      console.log(`   Protected routes: ${protectedCount} (${Math.round(protectedCount / totalCount * 100)}%)`);
      console.log(`   Catch-all handlers: ${catchAllCount}`);

      // Verify we have a reasonable ratio (most routes should be protected)
      expect(protectedCount).toBeGreaterThan(publicCount);
      expect(protectedCount).toBeGreaterThan(10); // Should have at least 10 protected routes
    });

    it('should list all public routes for audit', () => {
      const routes = app.routes;
      const publicRoutes = routes.filter(r => isPublicRoute(r.path));

      console.log(`\n🔓 Public Routes (no authentication required):`);
      publicRoutes.forEach(r => {
        console.log(`   ${r.method.padEnd(6)} ${r.path}`);
      });

      // Verify public routes match our documented list (approximately)
      expect(publicRoutes.length).toBeLessThanOrEqual(PUBLIC_ROUTES.length + 5); // Allow some flexibility for route patterns
    });
  });

  describe('Security Requirements', () => {
    it('should not leak information about resource existence without auth', async () => {
      const testPaths = [
        '/resources/nonexistent-resource-id',
        '/api/resources/nonexistent-resource-id/events',
        '/annotations/nonexistent-anno-id?resourceId=test',
      ];

      for (const path of testPaths) {
        const res = await app.request(path, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        expect(res.status).toBe(401);

        const body = await res.json() as { error: string };

        // Should NOT reveal whether the resource exists
        expect(body.error.toLowerCase()).not.toContain('not found');
        expect(body.error.toLowerCase()).not.toContain('resource');
        expect(body.error.toLowerCase()).not.toContain('annotation');
        expect(body.error.toLowerCase()).not.toContain('exist');
      }
    });
  });
});
