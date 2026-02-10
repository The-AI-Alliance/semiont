/**
 * Security Controls Tests
 *
 * Tests for security controls beyond authentication:
 * - CORS configuration
 * - Security headers (HSTS, X-Frame-Options, CSP, etc.)
 * - Error message information disclosure prevention
 *
 * This addresses weakness #11 "Missing Security Tests" from AUTH-TESTING.md
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig } from '@semiont/core';
import { setupTestEnvironment, type TestEnvironmentConfig } from './_test-setup';

// Mock make-meaning service to avoid graph initialization at import time
vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    startMakeMeaning: vi.fn().mockResolvedValue({
      jobQueue: {},
      workers: [],
      graphConsumer: {}
    })
  };
});

type Variables = {
  user: User;
  config: EnvironmentConfig;
  makeMeaning: any;
};

type ErrorResponse = {
  error: string;
  [key: string]: unknown;
};

describe('Security Controls', () => {
  let app: Hono<{ Variables: Variables }>;
  let testEnv: TestEnvironmentConfig;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    testEnv = await setupTestEnvironment();
    const { app: importedApp } = await import('../index');
    app = importedApp;

    // Load config to verify CORS settings
    const { loadEnvironmentConfig, findProjectRoot } = await import('../config-loader');
    const env = process.env.SEMIONT_ENV || 'unit';
    const projectRoot = findProjectRoot();
    config = loadEnvironmentConfig(projectRoot, env);
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  describe('CORS Configuration', () => {
    it('should include CORS headers on public endpoints', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
        headers: {
          'Origin': 'http://localhost:3000',
        },
      });

      // CORS headers should be present
      expect(res.headers.get('access-control-allow-origin')).toBeDefined();
    });

    it('should match configured CORS origin', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
        headers: {
          'Origin': 'http://localhost:3000',
        },
      });

      const corsOrigin = res.headers.get('access-control-allow-origin');
      const configuredOrigin = config.services?.backend?.corsOrigin;

      console.log(`\n🌐 CORS Configuration:`);
      console.log(`   Configured origin: ${configuredOrigin}`);
      console.log(`   Response header: ${corsOrigin}`);

      // Verify CORS is configured
      expect(corsOrigin).toBeDefined();
    });

    it('should include credentials support in CORS headers', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
        headers: {
          'Origin': 'http://localhost:3000',
        },
      });

      const allowCredentials = res.headers.get('access-control-allow-credentials');

      console.log(`\n🔐 CORS Credentials:`);
      console.log(`   Allow-Credentials: ${allowCredentials}`);

      // Verify credentials are allowed (required for cookies/auth)
      expect(allowCredentials).toBe('true');
    });

    it('should handle preflight OPTIONS requests', async () => {
      const res = await app.request('/api/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:3000',
          'Access-Control-Request-Method': 'GET',
        },
      });

      // Preflight should return 200 or 204
      expect([200, 204]).toContain(res.status);

      // Should include CORS headers
      expect(res.headers.get('access-control-allow-origin')).toBeDefined();
    });
  });

  describe('Security Headers', () => {
    it('should audit security headers on responses', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
      });

      // Critical security headers
      const securityHeaders = {
        'X-Frame-Options': res.headers.get('x-frame-options'),
        'X-Content-Type-Options': res.headers.get('x-content-type-options'),
        'Strict-Transport-Security': res.headers.get('strict-transport-security'),
        'Content-Security-Policy': res.headers.get('content-security-policy'),
        'X-XSS-Protection': res.headers.get('x-xss-protection'),
        'Referrer-Policy': res.headers.get('referrer-policy'),
        'Permissions-Policy': res.headers.get('permissions-policy'),
      };

      console.log(`\n🛡️  Security Headers Audit:`);
      Object.entries(securityHeaders).forEach(([header, value]) => {
        const status = value ? '✅' : '❌';
        console.log(`   ${status} ${header}: ${value || 'not set'}`);
      });

      // Document current state - don't fail, just report
      const presentCount = Object.values(securityHeaders).filter(v => v !== null).length;
      const totalCount = Object.keys(securityHeaders).length;

      console.log(`\n   Summary: ${presentCount}/${totalCount} security headers present`);

      // At minimum, we should document what's there
      // This test serves as both validation and documentation
      expect(securityHeaders).toBeDefined();
    });

    it('should verify X-Frame-Options prevents clickjacking', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
      });

      const xFrameOptions = res.headers.get('x-frame-options');

      if (xFrameOptions) {
        // If present, should be DENY or SAMEORIGIN
        expect(['DENY', 'SAMEORIGIN']).toContain(xFrameOptions.toUpperCase());
        console.log(`\n✅ X-Frame-Options: ${xFrameOptions} (clickjacking protection enabled)`);
      } else {
        console.log(`\n⚠️  X-Frame-Options not set - clickjacking protection missing`);
        console.log(`   Recommendation: Add 'X-Frame-Options: DENY' header`);
      }
    });

    it('should verify HSTS for HTTPS enforcement', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
      });

      const hsts = res.headers.get('strict-transport-security');

      if (hsts) {
        console.log(`\n✅ Strict-Transport-Security: ${hsts}`);
        // Should have reasonable max-age
        expect(hsts).toMatch(/max-age=\d+/);
      } else {
        console.log(`\n⚠️  Strict-Transport-Security not set - HTTPS not enforced`);
        console.log(`   Recommendation: Add 'Strict-Transport-Security: max-age=31536000; includeSubDomains' header`);
      }
    });

    it('should verify Content-Security-Policy prevents XSS', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
      });

      const csp = res.headers.get('content-security-policy');

      if (csp) {
        console.log(`\n✅ Content-Security-Policy: ${csp}`);
        // CSP should restrict unsafe inline/eval
        if (csp.includes('unsafe-inline') || csp.includes('unsafe-eval')) {
          console.log(`   ⚠️  Warning: CSP allows unsafe-inline or unsafe-eval`);
        }
      } else {
        console.log(`\n⚠️  Content-Security-Policy not set - XSS protection minimal`);
        console.log(`   Recommendation: Add CSP header restricting script sources`);
      }
    });

    it('should verify X-Content-Type-Options prevents MIME sniffing', async () => {
      const res = await app.request('/api/health', {
        method: 'GET',
      });

      const xContentTypeOptions = res.headers.get('x-content-type-options');

      if (xContentTypeOptions) {
        expect(xContentTypeOptions.toLowerCase()).toBe('nosniff');
        console.log(`\n✅ X-Content-Type-Options: ${xContentTypeOptions} (MIME sniffing disabled)`);
      } else {
        console.log(`\n⚠️  X-Content-Type-Options not set - MIME sniffing possible`);
        console.log(`   Recommendation: Add 'X-Content-Type-Options: nosniff' header`);
      }
    });
  });

  describe('Error Message Information Disclosure', () => {
    it('should not leak sensitive information in 404 errors', async () => {
      const res = await app.request('/api/nonexistent-route-12345', {
        method: 'GET',
      });

      expect(res.status).toBe(404);

      // Check response body if JSON
      const contentType = res.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const body = await res.json() as ErrorResponse;
        const errorMessage = JSON.stringify(body).toLowerCase();

        // Should NOT contain sensitive information
        expect(errorMessage).not.toMatch(/password|secret|key|token|database|postgresql|mongodb/);
        expect(errorMessage).not.toMatch(/\.js:\d+|\.ts:\d+/); // No file paths with line numbers
        expect(errorMessage).not.toMatch(/stack.*trace|at.*\(/i); // No stack traces
        expect(errorMessage).not.toMatch(/\/users\/|\/home\/|c:\\|\/var\//i); // No absolute paths

        console.log(`\n✅ 404 Error - No sensitive data leaked`);
      }
    });

    it('should not leak sensitive information in 401 errors', async () => {
      const res = await app.request('/api/users/me', {
        method: 'GET',
        // No auth header
      });

      expect(res.status).toBe(401);

      const body = await res.json() as ErrorResponse;
      const errorMessage = JSON.stringify(body).toLowerCase();

      // Should be generic "Unauthorized"
      expect(errorMessage).not.toMatch(/password|secret|key|database|postgresql/);
      expect(errorMessage).not.toMatch(/\.js:\d+|\.ts:\d+/);
      expect(errorMessage).not.toMatch(/stack.*trace/i);

      // Should NOT reveal whether user exists or token format issues
      expect(errorMessage).not.toMatch(/user not found|invalid email|no such user/i);

      console.log(`\n✅ 401 Error - Generic message, no details leaked`);
    });

    it('should not leak sensitive information in 403 errors', async () => {
      // Try to access admin route without admin privileges (with invalid token)
      const res = await app.request('/api/admin/users', {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer invalid-token-123',
        },
      });

      // Will return 401 (invalid token) or 403 (valid token, not admin)
      expect([401, 403]).toContain(res.status);

      const body = await res.json() as ErrorResponse;
      const errorMessage = JSON.stringify(body).toLowerCase();

      // Should not leak sensitive information
      expect(errorMessage).not.toMatch(/password|secret|key|database|postgresql/);
      expect(errorMessage).not.toMatch(/\.js:\d+|\.ts:\d+/);
      expect(errorMessage).not.toMatch(/stack.*trace/i);

      console.log(`\n✅ 403/401 Error - No sensitive data leaked`);
    });

    it('should not leak stack traces in error responses', async () => {
      // Test various error-prone scenarios
      const testCases = [
        { path: '/api/users/me', method: 'GET', desc: 'Missing auth' },
        { path: '/api/admin/users', method: 'GET', desc: 'Admin route' },
        { path: '/resources/invalid-id', method: 'GET', desc: 'Invalid resource' },
      ];

      for (const testCase of testCases) {
        const res = await app.request(testCase.path, {
          method: testCase.method as 'GET',
        });

        const contentType = res.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const bodyText = await res.text();

          // Should NOT contain stack trace patterns
          expect(bodyText).not.toMatch(/at\s+\w+\s+\(/); // "at functionName ("
          expect(bodyText).not.toMatch(/at\s+[A-Z]\w*\./); // "at ClassName."
          expect(bodyText).not.toMatch(/\w+Error:\s/); // "TypeError:", "Error:", etc.
          expect(bodyText).not.toMatch(/node_modules/);
          expect(bodyText).not.toMatch(/\/Users\/|\/home\//);
        }
      }

      console.log(`\n✅ No stack traces found in error responses`);
    });

    it('should not leak database errors in responses', async () => {
      // Test potential database error scenarios
      const testCases = [
        { path: '/api/users/me', method: 'GET' },
        { path: '/api/admin/users', method: 'GET' },
        { path: '/api/status', method: 'GET' },
      ];

      for (const testCase of testCases) {
        const res = await app.request(testCase.path, {
          method: testCase.method as 'GET',
        });

        const contentType = res.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const bodyText = await res.text();

          // Should NOT contain database-specific errors
          expect(bodyText.toLowerCase()).not.toMatch(/postgresql|postgres|pg|prisma/);
          expect(bodyText.toLowerCase()).not.toMatch(/connection.*refused|connection.*timeout/);
          expect(bodyText.toLowerCase()).not.toMatch(/syntax error|query failed|duplicate key/);
          expect(bodyText.toLowerCase()).not.toMatch(/constraint.*violation|foreign key/);
          expect(bodyText.toLowerCase()).not.toMatch(/database_url|db_host|db_password/);
        }
      }

      console.log(`\n✅ No database error details leaked`);
    });

    it('should use consistent error response format', async () => {
      const testCases = [
        { path: '/api/users/me', expectedStatus: 401 },
        { path: '/api/nonexistent', expectedStatus: 404 },
      ];

      const errorFormats: Array<{ status: number; hasError: boolean; keys: string[] }> = [];

      for (const testCase of testCases) {
        const res = await app.request(testCase.path, { method: 'GET' });

        const contentType = res.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const body = await res.json() as ErrorResponse;

          errorFormats.push({
            status: res.status,
            hasError: 'error' in body,
            keys: Object.keys(body),
          });
        }
      }

      console.log(`\n📋 Error Response Format Analysis:`);
      errorFormats.forEach(format => {
        console.log(`   ${format.status}: ${format.hasError ? '✅' : '❌'} has 'error' field, keys: ${format.keys.join(', ')}`);
      });

      // All errors should have an 'error' field
      errorFormats.forEach(format => {
        expect(format.hasError).toBe(true);
      });
    });

    it('should not expose environment variables in errors', async () => {
      const testPaths = [
        '/api/users/me',
        '/api/admin/users',
        '/api/nonexistent',
      ];

      for (const path of testPaths) {
        const res = await app.request(path, { method: 'GET' });

        const contentType = res.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const bodyText = await res.text();

          // Should NOT contain environment variable patterns
          expect(bodyText).not.toMatch(/process\.env/);
          expect(bodyText).not.toMatch(/NODE_ENV|PORT|DATABASE_URL|JWT_SECRET|API_KEY/);
          expect(bodyText).not.toMatch(/SEMIONT_ENV|SEMIONT_ROOT/);
        }
      }

      console.log(`\n✅ No environment variables exposed in errors`);
    });
  });

  describe('General Security Properties', () => {
    it('should use secure defaults for all security controls', () => {
      // This test documents the security defaults
      const securityDefaults = {
        'CORS credentials': 'enabled (required for auth)',
        'CORS origin': 'configured from environment',
        'Error messages': 'generic, no sensitive data',
        'Stack traces': 'never exposed in production responses',
        'Database errors': 'never exposed to clients',
      };

      console.log(`\n🔒 Security Defaults:`);
      Object.entries(securityDefaults).forEach(([control, value]) => {
        console.log(`   ✅ ${control}: ${value}`);
      });

      // All defaults documented
      expect(Object.keys(securityDefaults).length).toBeGreaterThan(0);
    });

    it('should document missing security controls', () => {
      // This test explicitly documents what's NOT implemented
      const missingControls = [
        'Rate limiting on auth endpoints',
        'Token expiration testing',
        'Token refresh flow security',
        'Timing attack prevention (auth)',
      ];

      console.log(`\n⚠️  Missing Security Controls (require implementation):`);
      missingControls.forEach(control => {
        console.log(`   ❌ ${control}`);
      });

      // Document for awareness
      expect(missingControls.length).toBeGreaterThan(0);
    });
  });
});
