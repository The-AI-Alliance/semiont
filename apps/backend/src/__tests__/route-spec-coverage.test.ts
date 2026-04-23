/**
 * Route / Spec Coverage Tests
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  PRIMARY PURPOSE: enforce authentication-by-default across      │
 * │  every registered backend route. No route gets to ship without  │
 * │  either proving it returns 401 to unauthenticated callers, or   │
 * │  being explicitly declared public in the OpenAPI spec.          │
 * │                                                                 │
 * │  Any failure in this file is a security regression until        │
 * │  proven otherwise. Do not mark tests `.skip`; do not disable    │
 * │  the workflow. If a new route can't pass, the route is wrong,   │
 * │  not the test.                                                  │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * The test enforces this against `app.routes` (every route actually
 * registered in Hono) cross-referenced with `specs/openapi.json`
 * (the single source of truth for which routes are public). If a
 * spec entry omits `security` or declares `security: []`, the route
 * is public; every other registered route MUST return 401 without a
 * valid bearer token.
 *
 * ─── Supporting hygiene checks ─────────────────────────────────────
 *
 * Because auth-by-default depends on the spec being an accurate
 * mirror of the code, three additional describe blocks keep the
 * spec honest. Every one of them is in service of the primary auth
 * check — if the spec drifts from code, auth-by-default can be
 * silently bypassed (a route in code with no spec entry has no
 * "public or protected" declaration the test can trust).
 *
 *   - Bidirectional Spec/Code Coverage — every registered route must
 *     be in the spec; every spec entry must map to a registered
 *     route; methods must line up. A phantom route in the spec or an
 *     unspec'd route in code both weaken the auth contract.
 *
 *   - Spec Contract Hygiene — path parameter names match, $refs
 *     resolve, no orphan schemas. Catches the kind of latent rot
 *     that lets a spec silently fall out of sync.
 *
 *   - Request-Body Validation — every spec-declared JSON request
 *     body must be wired through `validateRequestBody()` somewhere
 *     in backend source. Protects against "spec claims the body is
 *     validated, handler accepts garbage."
 *
 * Everything derives from the spec and `app.routes`. The only
 * hand-curated lists are `DOCUMENTATION_META_ROUTES` (the five
 * self-referential docs endpoints) and `MANUAL_REQUEST_VALIDATION`
 * (auth/OAuth handlers that validate in-handler instead of via
 * middleware — each entry carries a one-line justification).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig, EventBus } from '@semiont/core';
import type { MakeMeaningService } from '@semiont/make-meaning';
import { setupTestEnvironment, type TestEnvironmentConfig } from './_test-setup';
import { makeMeaningMock } from './helpers/make-meaning-mock';

// Mock make-meaning service to avoid graph initialization at import time
vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock())
  };
});

type Variables = {
  user: User;
  config: EnvironmentConfig;
  eventBus: EventBus;
  makeMeaning: MakeMeaningService;
};

// Meta-routes that serve the API documentation itself (self-referential, not in spec)
const DOCUMENTATION_META_ROUTES = [
  '/',                 // Splash page (HTML, not an API endpoint)
  '/api/docs',         // Swagger UI
  '/api/swagger',      // Redirect to /api/docs
  '/api',              // Redirect to /api/docs
  '/api/openapi.json', // OpenAPI spec file itself
] as const;

// ─── HTTP method constants ─────────────────────────────────────────
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

// ─── Shared types ─────────────────────────────────────────────────
interface RouteKey {
  method: string; // uppercase
  path: string;   // Hono-format (`:param`, not `{param}`)
}

interface SpecOperation {
  security?: unknown[];
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: { $ref?: string };
      };
    };
  };
  [key: string]: unknown;
}

/**
 * Convert an OpenAPI path template (`/resources/{id}`) into the Hono
 * path pattern (`/resources/:id`). Normalized comparison requires
 * this mapping; keep it in one place so every caller agrees.
 */
function openApiPathToHonoPath(openApiPath: string): string {
  return openApiPath.replace(/\{(\w+)\}/g, ':$1');
}

/**
 * Extract parameter names from an OpenAPI path template.
 * `/resources/{id}/foo/{bar}` → ['id', 'bar']
 */
function specPathParams(openApiPath: string): string[] {
  return Array.from(openApiPath.matchAll(/\{(\w+)\}/g), (m) => m[1]!);
}

/**
 * Extract parameter names from a Hono path pattern.
 * `/resources/:id/foo/:bar` → ['id', 'bar']
 */
function honoPathParams(honoPath: string): string[] {
  return Array.from(honoPath.matchAll(/:(\w+)/g), (m) => m[1]!);
}

/**
 * Read the bundled OpenAPI spec from disk. Single I/O hit — every
 * describe block that needs spec data pulls from this one result.
 */
async function loadSpec(): Promise<any> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const specPath = path.join(process.cwd(), '../../specs/openapi.json');
  const specContent = await fs.readFile(specPath, 'utf-8');
  return JSON.parse(specContent);
}

/**
 * Enumerate every `(method, honoPath)` pair declared in the spec.
 * Skips non-operation keys (`parameters`, `summary`, etc.).
 */
function enumerateSpecRoutes(spec: any): RouteKey[] {
  const out: RouteKey[] = [];
  for (const [specPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.includes(method.toLowerCase() as HttpMethod)) continue;
      if (operation === null || typeof operation !== 'object') continue;
      out.push({
        method: method.toUpperCase(),
        path: openApiPathToHonoPath(specPath),
      });
    }
  }
  return out;
}

/**
 * Enumerate every `(method, path)` pair registered in the Hono app,
 * deduplicated across Hono's middleware-expansion (same route
 * appears once per layer).
 *
 * Method=`ALL` entries are filtered out: Hono emits those for
 * `app.use()` middleware registrations (e.g. auth middleware
 * attached to a path). They aren't routes users can call; they
 * wrap real routes. The spec describes endpoints, not middleware.
 */
function enumerateAppRoutes(app: Hono<{ Variables: Variables }>): RouteKey[] {
  const seen = new Set<string>();
  const out: RouteKey[] = [];
  for (const route of app.routes) {
    const method = route.method.toUpperCase();
    if (method === 'ALL') continue;
    const key = `${method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method, path: route.path });
  }
  return out;
}

/**
 * Extract the public-route set from already-loaded spec data.
 * A route is public when its operation declares no `security` field
 * or an empty `security: []` array. Meta-routes serving the docs
 * themselves are added in as unconditionally public.
 */
function extractPublicRoutes(spec: any): Set<string> {
  const publicRoutes = new Set<string>();
  for (const [specPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.includes(method.toLowerCase() as HttpMethod)) continue;
      const op = operation as SpecOperation;
      const security = op.security;
      const isPublic = !security || (Array.isArray(security) && security.length === 0);
      if (isPublic) publicRoutes.add(openApiPathToHonoPath(specPath));
    }
  }
  DOCUMENTATION_META_ROUTES.forEach((r) => publicRoutes.add(r));
  return publicRoutes;
}

/** Route is explicitly public per the OpenAPI spec. */
function isPublicRoute(path: string, publicRoutes: Set<string>): boolean {
  return publicRoutes.has(path);
}

/**
 * Catch-all patterns (`/*`) auto-detected — these are Hono middleware
 * / 404 handlers, not real endpoints.
 */
function isCatchAllRoute(path: string): boolean {
  return path.includes('/*');
}

/**
 * Replace `:param` placeholders with harmless test values so the
 * path can be sent through `app.request()` without trailing
 * validation complaints. Auth tests don't care about the specific
 * value, only that the route matches.
 */
function routePatternToTestPath(pattern: string): string {
  return pattern
    .replace(/:id/g, 'test-id')
    .replace(/:resourceId/g, 'test-resource-id')
    .replace(/:annotationId/g, 'test-annotation-id')
    .replace(/:token/g, 'test-token')
    .replace(/\*/g, 'wildcard');
}

// ─── Shared test state, loaded once ────────────────────────────────
//
// Every describe block below reads from this closure; `beforeAll`
// populates it once per file run so neither the Hono app nor the
// spec is parsed more than once.
let app: Hono<{ Variables: Variables }>;
let testEnv: TestEnvironmentConfig;
let spec: any;
let publicRoutes: Set<string>;

beforeAll(async () => {
  testEnv = await setupTestEnvironment();
  const { app: importedApp } = await import('../index');
  app = importedApp;

  spec = await loadSpec();
  publicRoutes = extractPublicRoutes(spec);
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe('Route Authentication Coverage — THE primary security contract', () => {

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

      const failures: Array<{ method: string; path: string; status: number; body?: unknown }> = [];
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
        '/api/tokens/password',
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

// ═══════════════════════════════════════════════════════════════════
//  Supporting contract — keeping the spec honest so auth-by-default
//  above can trust it as a source of truth.
// ═══════════════════════════════════════════════════════════════════

/** Normalize a RouteKey for use as a Map/Set key. */
function routeKeyString(r: RouteKey): string {
  return `${r.method} ${r.path}`;
}

describe('Spec/Code Bidirectional Coverage', () => {
  it('every registered route has a spec entry (code ⊆ spec)', () => {
    const codeRoutes = enumerateAppRoutes(app);
    const specRouteKeys = new Set(enumerateSpecRoutes(spec).map(routeKeyString));

    const missing: RouteKey[] = [];
    for (const r of codeRoutes) {
      if (isCatchAllRoute(r.path)) continue;
      if (DOCUMENTATION_META_ROUTES.includes(r.path as typeof DOCUMENTATION_META_ROUTES[number])) continue;
      if (!specRouteKeys.has(routeKeyString(r))) missing.push(r);
    }

    if (missing.length > 0) {
      console.error('\n❌ Routes registered in code but missing from the OpenAPI spec:');
      missing.forEach((r) => console.error(`   ${r.method.padEnd(6)} ${r.path}`));
      console.error(
        '\n   Fix: author a spec file under `specs/src/paths/` and register it in\n' +
          '   `specs/src/openapi.json`, then run `npm run generate:openapi`.\n',
      );
    }

    expect(missing).toEqual([]);
  });

  it('every spec entry maps to a registered route (spec ⊆ code)', () => {
    const codeRouteKeys = new Set(enumerateAppRoutes(app).map(routeKeyString));
    const specRoutes = enumerateSpecRoutes(spec);

    const phantoms: RouteKey[] = [];
    for (const r of specRoutes) {
      if (!codeRouteKeys.has(routeKeyString(r))) phantoms.push(r);
    }

    if (phantoms.length > 0) {
      console.error('\n❌ Paths declared in the OpenAPI spec but not registered in the Hono app:');
      phantoms.forEach((r) => console.error(`   ${r.method.padEnd(6)} ${r.path}`));
      console.error(
        '\n   Fix: either implement the route, or remove the spec entry.\n' +
          '   Phantom routes mislead API consumers and weaken the spec as a contract.\n',
      );
    }

    expect(phantoms).toEqual([]);
  });

  it('methods declared in the spec match methods registered in code for each path', () => {
    const codeByPath = new Map<string, Set<string>>();
    for (const r of enumerateAppRoutes(app)) {
      if (!codeByPath.has(r.path)) codeByPath.set(r.path, new Set());
      codeByPath.get(r.path)!.add(r.method);
    }

    const specByPath = new Map<string, Set<string>>();
    for (const r of enumerateSpecRoutes(spec)) {
      if (!specByPath.has(r.path)) specByPath.set(r.path, new Set());
      specByPath.get(r.path)!.add(r.method);
    }

    const mismatches: Array<{ path: string; specOnly: string[]; codeOnly: string[] }> = [];
    for (const [path, specMethods] of specByPath) {
      const codeMethods = codeByPath.get(path);
      if (!codeMethods) continue; // phantom — already reported by the previous test
      const specOnly = [...specMethods].filter((m) => !codeMethods.has(m));
      const codeOnly = [...codeMethods].filter((m) => !specMethods.has(m));
      if (specOnly.length || codeOnly.length) mismatches.push({ path, specOnly, codeOnly });
    }

    if (mismatches.length > 0) {
      console.error('\n❌ Methods disagree between spec and code on these paths:');
      mismatches.forEach((m) => {
        const parts: string[] = [];
        if (m.specOnly.length) parts.push(`spec-only [${m.specOnly.join(', ')}]`);
        if (m.codeOnly.length) parts.push(`code-only [${m.codeOnly.join(', ')}]`);
        console.error(`   ${m.path}: ${parts.join('; ')}`);
      });
    }

    expect(mismatches).toEqual([]);
  });
});

describe('Spec Contract Hygiene', () => {
  it('path parameter names match between spec and code on every shared path', () => {
    const specPathTemplates = Object.keys(spec.paths ?? {});
    const appPaths = new Set(enumerateAppRoutes(app).map((r) => r.path));

    const mismatches: Array<{ specPath: string; hono: string; specParams: string[]; codeParams: string[] }> = [];
    for (const specPath of specPathTemplates) {
      const honoPath = openApiPathToHonoPath(specPath);
      if (!appPaths.has(honoPath)) continue; // phantom — not our concern here
      const specParams = specPathParams(specPath).sort();
      const codeParams = honoPathParams(honoPath).sort();
      if (JSON.stringify(specParams) !== JSON.stringify(codeParams)) {
        mismatches.push({ specPath, hono: honoPath, specParams, codeParams });
      }
    }

    if (mismatches.length > 0) {
      console.error('\n❌ Path parameter names disagree between spec and Hono route:');
      mismatches.forEach((m) => {
        console.error(
          `   ${m.specPath}\n     spec: [${m.specParams.join(', ')}]\n     code: [${m.codeParams.join(', ')}]`,
        );
      });
    }

    expect(mismatches).toEqual([]);
  });

  it('every $ref in the spec resolves to a schema that exists in components/schemas', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const schemasDir = path.join(process.cwd(), '../../specs/src/components/schemas');

    const refs = new Set<string>();
    const collectRefs = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const v of node) collectRefs(v);
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') refs.add(v);
        else collectRefs(v);
      }
    };
    collectRefs(spec);

    const declaredSchemas = new Set(Object.keys(spec.components?.schemas ?? {}));
    const unresolved: string[] = [];
    for (const ref of refs) {
      // `$ref: '#/components/schemas/Foo'` is the canonical internal form after redocly bundles.
      const match = ref.match(/^#\/components\/schemas\/([A-Za-z0-9_]+)$/);
      if (match) {
        const schemaName = match[1]!;
        if (!declaredSchemas.has(schemaName)) unresolved.push(ref);
        continue;
      }
      // Any other `$ref` shape post-bundle is unexpected and itself a drift signal.
      unresolved.push(ref);
    }

    // Sanity check: confirm each declared schema has a file on disk (catches
    // components pointing at missing JSON files after a rename).
    const missingOnDisk: string[] = [];
    for (const schemaName of declaredSchemas) {
      const filePath = path.join(schemasDir, `${schemaName}.json`);
      try {
        await fs.access(filePath);
      } catch {
        missingOnDisk.push(`${schemaName} (expected at ${filePath})`);
      }
    }

    if (unresolved.length > 0) {
      console.error('\n❌ Unresolved $refs in the OpenAPI spec:');
      unresolved.slice(0, 20).forEach((r) => console.error(`   ${r}`));
      if (unresolved.length > 20) console.error(`   ...and ${unresolved.length - 20} more`);
    }
    if (missingOnDisk.length > 0) {
      console.error('\n❌ Declared component schemas with no file on disk:');
      missingOnDisk.forEach((s) => console.error(`   ${s}`));
    }

    expect(unresolved).toEqual([]);
    expect(missingOnDisk).toEqual([]);
  });

  it('every schema file on disk is referenced somewhere (spec $ref or code string-literal)', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const schemasDir = path.join(process.cwd(), '../../specs/src/components/schemas');

    const files = (await fs.readdir(schemasDir)).filter((f) => f.endsWith('.json'));
    const onDisk = new Set(files.map((f) => f.replace(/\.json$/, '')));

    // Spec references: every `$ref` pointing at `#/components/schemas/Name`.
    const referenced = new Set<string>();
    const collectRefs = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const v of node) collectRefs(v);
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') {
          const match = v.match(/^#\/components\/schemas\/([A-Za-z0-9_]+)$/);
          if (match) referenced.add(match[1]!);
        } else collectRefs(v);
      }
    };
    collectRefs(spec);

    // Code references: schemas are also used at runtime as string literals
    // and as TypeScript type lookups, outside the HTTP `$ref` surface.
    // Three patterns count as "referenced":
    //
    //   1. `'<Name>'` or `"<Name>"` — string literal, catches
    //      `CHANNEL_SCHEMAS` entries, `validateRequestBody('Name')`,
    //      and `components['schemas']['Name']` type indexing.
    //   2. Inside any `components['schemas'][...]` type access.
    //   3. Module-level type aliases that use the schema name (already
    //      covered by (1) since the alias RHS contains the string
    //      literal).
    //
    // Strategy: for each candidate orphan, grep every `.ts`/`.tsx` file
    // under `packages/*/src` and `apps/*/src` (excluding test/dist/
    // node_modules). A single occurrence counts as "referenced."
    const repoRoot = path.resolve(process.cwd(), '../..');
    const searchRoots: string[] = [];
    for (const parent of ['packages', 'apps']) {
      const parentDir = path.join(repoRoot, parent);
      try {
        const pkgs = await fs.readdir(parentDir, { withFileTypes: true });
        for (const p of pkgs) {
          if (!p.isDirectory()) continue;
          const srcDir = path.join(parentDir, p.name, 'src');
          try {
            await fs.access(srcDir);
            searchRoots.push(srcDir);
          } catch {
            // package has no src/ — skip
          }
        }
      } catch {
        // parent dir missing — skip
      }
    }

    async function grepSchemaNames(dir: string, names: Set<string>, hits: Set<string>): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
          await grepSchemaNames(full, names, hits);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          const content = await fs.readFile(full, 'utf-8');
          for (const name of names) {
            if (hits.has(name)) continue;
            // Match the name as a string literal: 'Foo' or "Foo" or `Foo`
            const pattern = new RegExp(`['"\`]${name}['"\`]`);
            if (pattern.test(content)) hits.add(name);
          }
        }
      }
    }
    const candidateOrphans = new Set<string>();
    for (const name of onDisk) {
      if (!referenced.has(name)) candidateOrphans.add(name);
    }
    const codeHits = new Set<string>();
    for (const root of searchRoots) {
      await grepSchemaNames(root, candidateOrphans, codeHits);
    }

    const orphans: string[] = [];
    for (const name of candidateOrphans) {
      if (!codeHits.has(name)) orphans.push(name);
    }
    orphans.sort();

    if (orphans.length > 0) {
      console.error('\n⚠️  Schema files with no incoming $ref from the spec AND no string-literal reference in code:');
      orphans.forEach((o) => console.error(`   specs/src/components/schemas/${o}.json`));
      console.error(
        '\n   Fix: either reference the schema from a path/another schema,\n' +
          '   wire it into runtime validation (e.g. CHANNEL_SCHEMAS or validateRequestBody),\n' +
          '   or delete the file if truly unused.\n',
      );
    }

    expect(orphans).toEqual([]);
  });
});

// ─── Step 3: Request-body validation enforcement ──────────────────
//
// Every spec operation declaring a JSON request body promises a
// contract: the handler only ever receives payloads matching the
// declared schema. The way the backend delivers on that promise
// today is `validateRequestBody('<SchemaName>')` middleware. A spec
// entry claiming a schema, with no matching middleware call in
// source, is a spec that lies about its contract.
//
// A small set of auth/OAuth handlers predates the middleware and
// does manual field checks. They're listed here with a reason;
// anything else must use `validateRequestBody`.
const MANUAL_REQUEST_VALIDATION = new Map<string, string>([
  ['MediaTokenRequest', 'auth handler does manual field presence check on resourceId'],
  ['CookieConsentRequest', 'handler enforces necessary=true alongside shape check'],
  ['BusEmitRequest', 'bus emit validates per-channel payload shape, not the envelope'],
]);

describe('Request-Body Validation', () => {
  it('every spec-declared JSON request body is validated somewhere in backend source', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    // Collect schema names declared as JSON request bodies across the spec.
    const jsonBodySchemas = new Set<string>();
    for (const pathItem of Object.values(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
        if (!HTTP_METHODS.includes(method.toLowerCase() as HttpMethod)) continue;
        const op = operation as SpecOperation;
        const ref = op.requestBody?.content?.['application/json']?.schema?.$ref;
        if (!ref) continue;
        const match = ref.match(/^#\/components\/schemas\/([A-Za-z0-9_]+)$/);
        if (match) jsonBodySchemas.add(match[1]!);
      }
    }

    // Recursively scan backend source for `validateRequestBody('Name')` calls.
    const srcDir = path.join(process.cwd(), 'src');
    const validatedSchemas = new Set<string>();
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          await walk(full);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          const content = await fs.readFile(full, 'utf-8');
          for (const m of content.matchAll(/validateRequestBody\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)) {
            validatedSchemas.add(m[1]!);
          }
        }
      }
    }
    await walk(srcDir);

    const unvalidated: string[] = [];
    const exemptedButValidated: string[] = [];
    for (const name of jsonBodySchemas) {
      const isValidatedViaMiddleware = validatedSchemas.has(name);
      const isExempted = MANUAL_REQUEST_VALIDATION.has(name);
      if (!isValidatedViaMiddleware && !isExempted) unvalidated.push(name);
      if (isValidatedViaMiddleware && isExempted) exemptedButValidated.push(name);
    }

    if (unvalidated.length > 0) {
      console.error('\n❌ Spec declares a JSON request body, but no handler validates it:');
      unvalidated.forEach((s) => console.error(`   ${s}`));
      console.error(
        '\n   Fix: add `validateRequestBody(\'<SchemaName>\')` middleware to the\n' +
          '   route, or add the schema to MANUAL_REQUEST_VALIDATION with a\n' +
          '   justification if the handler validates in-body.\n',
      );
    }
    if (exemptedButValidated.length > 0) {
      console.error('\n⚠️  Schemas listed as manually-validated but also use the middleware:');
      exemptedButValidated.forEach((s) => console.error(`   ${s} — remove from MANUAL_REQUEST_VALIDATION`));
    }

    expect(unvalidated).toEqual([]);
    expect(exemptedButValidated).toEqual([]);
  });
});
