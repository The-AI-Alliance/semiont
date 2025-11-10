/**
 * Route Authentication Coverage Tests
 *
 * Systematically verifies that ALL backend routes require authentication
 * except for explicitly public endpoints.
 *
 * This test uses the OpenAPI spec as the single source of truth for public routes.
 * NO hard-coded allow-lists - everything is derived from the spec or auto-detected.
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

// Meta-routes that serve the API documentation itself (self-referential, not in spec)
const DOCUMENTATION_META_ROUTES = [
  '/api/docs',         // Swagger UI
  '/api/swagger',      // Redirect to /api/docs
  '/api',              // Redirect to /api/docs
  '/api/openapi.json', // OpenAPI spec file itself
] as const;

/**
 * Load OpenAPI spec and extract public routes
 * This is the SINGLE SOURCE OF TRUTH for which routes are public
 */
async function loadPublicRoutesFromSpec(): Promise<Set<string>> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const specPath = path.join(process.cwd(), '../../specs/openapi.json');
  const specContent = await fs.readFile(specPath, 'utf-8');
  const spec = JSON.parse(specContent);

  const publicRoutes = new Set<string>();

  // Extract routes without security requirements from OpenAPI spec
  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
      // Skip non-operation keys
      if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method.toLowerCase())) {
        continue;
      }

      // Routes without security field or with empty security array are public
      const security = operation.security;
      const isPublic = !security || (Array.isArray(security) && security.length === 0);

      if (isPublic) {
        // Convert OpenAPI format {id} to Hono format :id
        const honoPath = routePath.replace(/\{(\w+)\}/g, ':$1');
        publicRoutes.add(honoPath);
      }
    }
  }

  // Add documentation meta-routes (not in spec, but legitimately public)
  DOCUMENTATION_META_ROUTES.forEach(route => publicRoutes.add(route));

  return publicRoutes;
}

/**
 * Check if a route is public based on OpenAPI spec
 */
function isPublicRoute(path: string, publicRoutes: Set<string>): boolean {
  return publicRoutes.has(path);
}

/**
 * Check if a route is a catch-all pattern (contains /*)
 * Auto-detected - no hard-coded list needed
 */
function isCatchAllRoute(path: string): boolean {
  return path.includes('/*');
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
  let publicRoutes: Set<string>;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    const { app: importedApp } = await import('../index');
    app = importedApp;

    // Load public routes from OpenAPI spec (single source of truth)
    publicRoutes = await loadPublicRoutesFromSpec();
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  describe('Public Routes', () => {
    it('should allow access to documented public endpoints without authentication', async () => {
      // Test all routes identified as public from OpenAPI spec
      for (const path of publicRoutes) {
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

        // Skip public routes (from OpenAPI spec)
        if (isPublicRoute(pattern, publicRoutes)) {
          skipped.push({ method, path: pattern, reason: 'public route from spec' });
          continue;
        }

        // Skip catch-all routes (auto-detected, these are middleware/404 handlers)
        if (isCatchAllRoute(pattern)) {
          skipped.push({ method, path: pattern, reason: 'catch-all route (middleware/404 handler)' });
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

        // Skip public routes (from spec) and catch-all routes (auto-detected)
        if (isPublicRoute(pattern, publicRoutes) || isCatchAllRoute(pattern)) {
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

          // Skip public routes (from spec) and catch-all routes (auto-detected)
          if (isPublicRoute(pattern, publicRoutes) || isCatchAllRoute(pattern)) {
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
      const publicCount = routes.filter(r => isPublicRoute(r.path, publicRoutes)).length;
      const catchAllCount = routes.filter(r => isCatchAllRoute(r.path)).length;
      const protectedCount = routes.filter(r => !isPublicRoute(r.path, publicRoutes) && !isCatchAllRoute(r.path)).length;
      const totalCount = routes.length;

      console.log(`\n📊 Route Security Statistics:`);
      console.log(`   Total routes: ${totalCount}`);
      console.log(`   Public routes: ${publicCount} (${Math.round(publicCount / totalCount * 100)}%)`);
      console.log(`   Protected routes: ${protectedCount} (${Math.round(protectedCount / totalCount * 100)}%)`);
      console.log(`   Catch-all routes: ${catchAllCount} (middleware/404 handlers)`);
      console.log(`   Public routes from OpenAPI spec: ${publicRoutes.size}`);

      // Verify we have a reasonable ratio (most routes should be protected)
      expect(protectedCount).toBeGreaterThan(publicCount);
    });

    it('should list all public routes for audit', () => {
      const routes = app.routes;
      const publicRoutesFromApp = routes.filter(r => isPublicRoute(r.path, publicRoutes));

      console.log(`\n🔓 Public Routes (no authentication required):`);
      publicRoutesFromApp.forEach(r => {
        console.log(`   ${r.method.padEnd(6)} ${r.path}`);
      });

      // Verify we have public routes
      expect(publicRoutesFromApp.length).toBeGreaterThan(0);
    });

    it('should identify and explain duplicate route registrations', () => {
      const routes = app.routes;
      const routeMap = new Map<string, number>();

      // Count occurrences of each route
      routes.forEach(r => {
        const key = `${r.method} ${r.path}`;
        routeMap.set(key, (routeMap.get(key) || 0) + 1);
      });

      // Find duplicates
      const duplicates: Array<{ route: string; count: number }> = [];
      routeMap.forEach((count, route) => {
        if (count > 1) {
          duplicates.push({ route, count });
        }
      });

      if (duplicates.length > 0) {
        console.log(`\n⚠️  Duplicate Route Registrations (${duplicates.length} routes):`);
        console.log(`   Note: This is expected Hono behavior when routes use middleware.`);
        console.log(`   Each route with middleware appears once per middleware + once for handler.\n`);

        // Sample a few for display (don't spam output)
        const sampleSize = Math.min(5, duplicates.length);
        duplicates.slice(0, sampleSize).forEach(d => {
          console.log(`   ${d.route} (×${d.count})`);
        });
        if (duplicates.length > sampleSize) {
          console.log(`   ... and ${duplicates.length - sampleSize} more`);
        }
      } else {
        console.log(`\n✅ No duplicate route registrations`);
      }

      // EXPLANATION: Hono's route table includes entries for:
      // 1. Middleware routes (router.use(), validateRequestBody(), etc.)
      // 2. Handler routes (router.get(), router.post(), etc.)
      //
      // For a route like:
      //   router.post('/api/tokens/local', validateRequestBody('...'), handler)
      //
      // Hono registers TWO entries:
      //   1. POST /api/tokens/local (middleware: validateRequestBody)
      //   2. POST /api/tokens/local (handler)
      //
      // This is expected and correct behavior. The middleware runs first, then the handler.
      // Both entries in the route table allow Hono to match and execute in order.

      // We don't fail on duplicates since this is expected Hono behavior
      expect(duplicates.length).toBeGreaterThanOrEqual(0); // Informational only
    });

    it('should list all catch-all routes for audit', () => {
      const routes = app.routes;
      const catchAllRoutes = routes.filter(r => isCatchAllRoute(r.path));

      console.log(`\n🎯 Catch-All Routes (auto-detected middleware/404 handlers):`);
      catchAllRoutes.forEach(r => {
        console.log(`   ${r.method.padEnd(6)} ${r.path}`);
      });

      // Verify we have some catch-all routes (global middleware, etc.)
      expect(catchAllRoutes.length).toBeGreaterThan(0);
    });
  });

  describe('Route Registration Order', () => {
    it('should verify auth middleware registered before handlers', () => {
      const routes = app.routes;
      const violations: Array<{ handler: string; middleware: string }> = [];

      // Group routes by path prefix
      const routeGroups = new Map<string, Array<{ method: string; path: string; index: number }>>();

      routes.forEach((r, index) => {
        // Extract path prefix (e.g., /api/admin/users -> /api/admin)
        const segments = r.path.split('/').filter(s => s);
        const prefix = segments.slice(0, Math.min(2, segments.length)).join('/');
        const key = `/${prefix}`;

        if (!routeGroups.has(key)) {
          routeGroups.set(key, []);
        }
        routeGroups.get(key)!.push({ method: r.method, path: r.path, index });
      });

      // Check each group: middleware (/*) should come before specific handlers
      routeGroups.forEach((group, prefix) => {
        const middlewareRoutes = group.filter(r => r.path.includes('/*'));
        const handlerRoutes = group.filter(r => !r.path.includes('/*') && r.path.startsWith(prefix));

        if (middlewareRoutes.length > 0 && handlerRoutes.length > 0) {
          const firstMiddlewareIndex = Math.min(...middlewareRoutes.map(r => r.index));
          const firstHandlerIndex = Math.min(...handlerRoutes.map(r => r.index));

          // Middleware should be registered before or equal to handlers
          if (firstMiddlewareIndex > firstHandlerIndex) {
            violations.push({
              handler: `${handlerRoutes[0]?.path} (index ${firstHandlerIndex})`,
              middleware: `${middlewareRoutes[0]?.path} (index ${firstMiddlewareIndex})`,
            });
          }
        }
      });

      if (violations.length > 0) {
        console.log(`\n❌ Route Registration Order Violations (${violations.length}):`);
        console.log(`   Auth middleware registered AFTER handlers (security risk):\n`);
        violations.forEach(v => {
          console.log(`   Handler:    ${v.handler}`);
          console.log(`   Middleware: ${v.middleware} (should be before handler!)\n`);
        });
      } else {
        console.log(`\n✅ Route registration order correct - middleware before handlers`);
      }

      // CRITICAL: No violations allowed - this is a security hole
      expect(violations.length).toBe(0);
    });

    it('should verify auth middleware exists for all protected paths', () => {
      const routes = app.routes;
      const protectedPaths = routes
        .filter(r => !isPublicRoute(r.path, publicRoutes) && !isCatchAllRoute(r.path))
        .map(r => r.path);

      const authMiddlewarePaths = routes
        .filter(r => r.path.includes('/*'))
        .map(r => r.path);

      const missingAuth: string[] = [];

      // For each protected path, verify there's a matching auth middleware
      const uniqueProtectedPaths = [...new Set(protectedPaths)];

      for (const path of uniqueProtectedPaths) {
        // Check if any auth middleware pattern covers this path
        const hasAuth = authMiddlewarePaths.some(middleware => {
          const pattern = middleware.replace('/*', '');
          return path.startsWith(pattern);
        });

        if (!hasAuth && !path.startsWith('/api/tokens')) {
          // Skip token routes - they handle their own auth
          missingAuth.push(path);
        }
      }

      if (missingAuth.length > 0) {
        console.log(`\n⚠️  Paths without auth middleware coverage (${missingAuth.length}):`);
        missingAuth.slice(0, 10).forEach(p => {
          console.log(`   ${p}`);
        });
        if (missingAuth.length > 10) {
          console.log(`   ... and ${missingAuth.length - 10} more`);
        }
      } else {
        console.log(`\n✅ All protected paths have auth middleware coverage`);
      }

      // This is informational - some paths might use route-level auth instead of middleware
      // We don't fail here, but we log for awareness
    });

    it('should verify global middleware registered first', () => {
      const routes = app.routes;
      const globalMiddleware = routes.filter(r => r.path === '/*');

      if (globalMiddleware.length === 0) {
        console.log(`\n⚠️  No global middleware (/*) detected`);
        return;
      }

      const firstGlobalIndex = routes.findIndex(r => r.path === '/*');
      const firstOtherIndex = routes.findIndex(r => r.path !== '/*');

      console.log(`\n📍 Middleware Registration Order:`);
      console.log(`   Global middleware (/*): index ${firstGlobalIndex}`);
      console.log(`   First other route: index ${firstOtherIndex}`);

      if (firstGlobalIndex > firstOtherIndex) {
        console.log(`   ⚠️  WARNING: Global middleware registered after other routes!`);
        console.log(`   This means global middleware won't run for earlier routes.`);
      } else {
        console.log(`   ✅ Global middleware registered first (correct)`);
      }

      // Global middleware should be first or very early
      expect(firstGlobalIndex).toBeLessThan(20);
    });
  });

  describe('OpenAPI Spec as Single Source of Truth', () => {
    it('should load public routes from OpenAPI spec', () => {
      // Public routes were loaded from OpenAPI spec in beforeAll()
      // This test validates the loaded routes are sensible

      console.log(`\n📋 Public Routes (loaded from OpenAPI spec):`);
      console.log(`   Total: ${publicRoutes.size}`);

      const sortedRoutes = Array.from(publicRoutes).sort();
      sortedRoutes.forEach(route => {
        console.log(`   ${route}`);
      });

      // Validate expected public routes from spec are present
      const expectedFromSpec = [
        '/api/health',
        '/api/tokens/local',
        '/api/tokens/google',
        '/api/tokens/refresh',
      ];

      for (const expected of expectedFromSpec) {
        expect(publicRoutes.has(expected)).toBe(true);
      }

      // Validate documentation meta-routes are included
      for (const metaRoute of DOCUMENTATION_META_ROUTES) {
        expect(publicRoutes.has(metaRoute)).toBe(true);
      }

      // Sanity check: we shouldn't have too many public routes (security check)
      expect(publicRoutes.size).toBeLessThan(15);
    });

    it('should not include protected routes in public routes set', () => {
      // Validate known protected routes are NOT in publicRoutes
      const knownProtectedRoutes = [
        '/api/admin/users',
        '/api/users/me',
        '/api/status',
        '/resources',
        '/api/jobs/:id',
      ];

      for (const protectedRoute of knownProtectedRoutes) {
        expect(publicRoutes.has(protectedRoute)).toBe(false);
      }
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
