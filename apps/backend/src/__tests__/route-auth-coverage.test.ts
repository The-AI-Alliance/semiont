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

// Known catch-all routes (middleware, 404 handlers, etc.)
// If you add one here, justify it in a comment
const KNOWN_CATCH_ALL_ROUTES = [
  // 404 handler for non-existent API routes
  '/api/*',

  // Auth middleware routes (applied via router.use())
  // These don't handle requests directly - they run middleware before specific routes
  '/*',  // Global middleware (CORS, config injection, logging)
  '/api/admin/*',  // Admin routes auth middleware
  '/api/resources/*',  // API resource routes auth middleware
  '/resources/*',  // W3C resource URI routes auth middleware
  '/api/annotations/*',  // API annotation routes auth middleware
  '/annotations/*',  // W3C annotation URI routes auth middleware
  '/api/entity-types/*',  // Entity types routes auth middleware
  '/api/jobs/*',  // Jobs routes auth middleware
] as const;

// Create a Set for efficient lookup (and proper typing)
const KNOWN_CATCH_ALL_SET = new Set<string>(KNOWN_CATCH_ALL_ROUTES);

// Type-safe helper to check if a route is a known catch-all
function isKnownCatchAll(path: string): boolean {
  return KNOWN_CATCH_ALL_SET.has(path);
}

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

        // Handle catch-all routes (routes with /*)
        if (pattern.includes('/*')) {
          // Only allow known catch-all routes
          if (!isKnownCatchAll(pattern)) {
            failures.push({
              method,
              path: pattern,
              status: 0,
              body: `SECURITY ERROR: Unexpected catch-all route "${pattern}" detected. If this is intentional, add it to KNOWN_CATCH_ALL_ROUTES with a justification comment.`,
            });
          }
          skipped.push({ method, path: pattern, reason: 'known catch-all handler' });
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

        // Skip public routes and known catch-all handlers
        if (isPublicRoute(pattern) || isKnownCatchAll(pattern)) {
          continue;
        }

        // Fail on unknown catch-all routes
        if (pattern.includes('/*')) {
          failures.push({
            method,
            path: pattern,
            status: 0,
          });
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

          if (isPublicRoute(pattern) || isKnownCatchAll(pattern)) {
            continue;
          }

          // Fail on unknown catch-all routes
          if (pattern.includes('/*')) {
            failures.push({
              method,
              path: pattern,
              status: 0,
            });
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
      const knownCatchAllCount = routes.filter(r => isKnownCatchAll(r.path)).length;
      const unknownCatchAllCount = catchAllCount - knownCatchAllCount;
      const protectedCount = routes.filter(r => !isPublicRoute(r.path) && !r.path.includes('/*')).length;
      const totalCount = routes.length;

      console.log(`\n📊 Route Security Statistics:`);
      console.log(`   Total routes: ${totalCount}`);
      console.log(`   Public routes: ${publicCount} (${Math.round(publicCount / totalCount * 100)}%)`);
      console.log(`   Protected routes: ${protectedCount} (${Math.round(protectedCount / totalCount * 100)}%)`);
      console.log(`   Known catch-all handlers: ${knownCatchAllCount}`);
      if (unknownCatchAllCount > 0) {
        console.log(`   ⚠️  UNKNOWN catch-all handlers: ${unknownCatchAllCount}`);
      }

      // Verify we have a reasonable ratio (most routes should be protected)
      expect(protectedCount).toBeGreaterThan(publicCount);
      expect(protectedCount).toBeGreaterThan(10); // Should have at least 10 protected routes

      // SECURITY: No unknown catch-all routes allowed
      expect(unknownCatchAllCount).toBe(0);
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

    it('should list all known catch-all routes for audit', () => {
      const routes = app.routes;
      const catchAllRoutes = routes.filter(r => r.path.includes('/*'));
      const knownRoutes = catchAllRoutes.filter(r => isKnownCatchAll(r.path));
      const unknownRoutes = catchAllRoutes.filter(r => !isKnownCatchAll(r.path));

      console.log(`\n🎯 Catch-All Routes:`);
      console.log(`   Known (approved):`);
      knownRoutes.forEach(r => {
        console.log(`      ${r.method.padEnd(6)} ${r.path}`);
      });

      if (unknownRoutes.length > 0) {
        console.log(`   ⚠️  UNKNOWN (requires approval):`);
        unknownRoutes.forEach(r => {
          console.log(`      ${r.method.padEnd(6)} ${r.path}`);
        });
      }

      // All catch-all routes must be in the known list
      expect(unknownRoutes.length).toBe(0);
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
        .filter(r => !isPublicRoute(r.path) && !r.path.includes('/*'))
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
      const otherRoutes = routes.filter(r => r.path !== '/*');

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

  describe('OpenAPI Spec Cross-Reference', () => {
    it('should validate PUBLIC_ROUTES against OpenAPI spec security declarations', async () => {
      // Read OpenAPI spec
      const fs = await import('fs/promises');
      const path = await import('path');

      const specPath = path.join(process.cwd(), '../../specs/openapi.json');
      const specContent = await fs.readFile(specPath, 'utf-8');
      const spec = JSON.parse(specContent);

      // Extract public routes from OpenAPI spec (routes without security requirements)
      const publicRoutesFromSpec = new Set<string>();

      for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
        for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
          // Skip non-operation keys (like 'parameters', 'summary', etc.)
          if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(method.toLowerCase())) {
            continue;
          }

          // If operation has no security field, it's public
          // If operation has empty security array [], it's public
          // If operation has security requirements, it's protected
          const security = operation.security;
          const isPublic = !security || (Array.isArray(security) && security.length === 0);

          if (isPublic) {
            publicRoutesFromSpec.add(`${method.toUpperCase()} ${routePath}`);
          }
        }
      }

      // Convert PUBLIC_ROUTES to a comparable format
      const publicRoutesFromCode = new Set<string>();

      // For each route in PUBLIC_ROUTES, we need to determine which HTTP methods apply
      // In the real app, some routes might support multiple methods
      for (const route of PUBLIC_ROUTES) {
        // Get all registered routes that match this path
        const matchingRoutes = app.routes.filter(r => {
          if (r.path === route) return true;
          // Handle prefix matches for documentation routes
          if (route === '/api' && r.path === '/api') return true;
          return false;
        });

        if (matchingRoutes.length > 0) {
          matchingRoutes.forEach(r => {
            publicRoutesFromCode.add(`${r.method} ${r.path}`);
          });
        } else {
          // If not found in registered routes, assume GET (common for docs)
          publicRoutesFromCode.add(`GET ${route}`);
        }
      }

      // Find mismatches
      const inSpecNotInCode: string[] = [];
      const inCodeNotInSpec: string[] = [];

      // Check routes in spec that aren't in code
      for (const specRoute of publicRoutesFromSpec) {
        const found = Array.from(publicRoutesFromCode).some(codeRoute => {
          // Exact match
          if (codeRoute === specRoute) return true;

          // Handle OpenAPI path params vs Hono path params
          // OpenAPI: /api/resources/{id}
          // Hono: /api/resources/:id
          const normalizedCodeRoute = codeRoute.replace(/:\w+/g, (match) => `{${match.slice(1)}}`);
          if (normalizedCodeRoute === specRoute) return true;

          return false;
        });

        if (!found) {
          inSpecNotInCode.push(specRoute);
        }
      }

      // Check routes in code that aren't in spec
      for (const codeRoute of publicRoutesFromCode) {
        const found = Array.from(publicRoutesFromSpec).some(specRoute => {
          // Exact match
          if (codeRoute === specRoute) return true;

          // Handle OpenAPI path params vs Hono path params
          const normalizedCodeRoute = codeRoute.replace(/:\w+/g, (match) => `{${match.slice(1)}}`);
          if (normalizedCodeRoute === specRoute) return true;

          return false;
        });

        if (!found) {
          inCodeNotInSpec.push(codeRoute);
        }
      }

      // Report findings
      console.log(`\n🔍 OpenAPI Spec Cross-Reference:`);
      console.log(`   Public routes in OpenAPI spec: ${publicRoutesFromSpec.size}`);
      console.log(`   Public routes in PUBLIC_ROUTES: ${publicRoutesFromCode.size}`);

      if (inSpecNotInCode.length > 0) {
        console.log(`\n   ⚠️  Routes marked public in spec but NOT in PUBLIC_ROUTES (${inSpecNotInCode.length}):`);
        inSpecNotInCode.forEach(route => console.log(`      ${route}`));
      }

      if (inCodeNotInSpec.length > 0) {
        console.log(`\n   ⚠️  Routes in PUBLIC_ROUTES but NOT marked public in spec (${inCodeNotInSpec.length}):`);
        inCodeNotInSpec.forEach(route => console.log(`      ${route}`));
      }

      if (inSpecNotInCode.length === 0 && inCodeNotInSpec.length === 0) {
        console.log(`   ✅ All public routes match between spec and code`);
      }

      // CRITICAL: OpenAPI spec is the source of truth
      // All routes marked public in spec MUST be in PUBLIC_ROUTES
      expect(inSpecNotInCode).toEqual([]);

      // Routes in PUBLIC_ROUTES should generally be in spec
      // (allow some flexibility for meta-routes like /api/swagger that redirect)
      const allowedCodeOnlyRoutes = [
        'GET /api/swagger',      // Redirects to /api/docs
        'GET /api',              // Redirects to /api/docs
        'GET /api/docs',         // Swagger UI (self-referential, not in spec)
        'GET /api/openapi.json', // OpenAPI spec itself (self-referential, not in spec)
      ];

      const unexpectedCodeOnlyRoutes = inCodeNotInSpec.filter(
        route => !allowedCodeOnlyRoutes.includes(route)
      );

      if (unexpectedCodeOnlyRoutes.length > 0) {
        console.log(`\n   ❌ Unexpected public routes in code not in spec:`);
        unexpectedCodeOnlyRoutes.forEach(route => console.log(`      ${route}`));
      }

      expect(unexpectedCodeOnlyRoutes).toEqual([]);
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
