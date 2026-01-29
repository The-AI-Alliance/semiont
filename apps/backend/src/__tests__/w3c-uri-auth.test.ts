/**
 * W3C URI Authentication Tests
 *
 * Tests that W3C-compliant URI endpoints require authentication
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig } from '@semiont/core';
import { setupTestEnvironment, type TestEnvironmentConfig } from './_test-setup';

type Variables = {
  user: User;
  config: EnvironmentConfig;
};

type ErrorResponse = {
  error: string;
};

// Mock the database before any imports to avoid connection attempts

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

describe('W3C URI Authentication', () => {
  let app: Hono<{ Variables: Variables }>;
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

  describe('GET /resources/:id', () => {
    it('should reject unauthenticated requests with 401', async () => {
      const res = await app.request('/resources/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });

    it('should reject requests with invalid token with 401', async () => {
      const res = await app.request('/resources/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer invalid-token-12345',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });

    it('should reject requests with malformed Authorization header with 401', async () => {
      const res = await app.request('/resources/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'InvalidFormat token123',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });

    it('should reject requests without Bearer prefix with 401', async () => {
      const res = await app.request('/resources/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'some-token-without-bearer',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });
  });

  describe('GET /annotations/:id', () => {
    it('should reject unauthenticated requests with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?resourceId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });

    it('should reject requests with invalid token with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?resourceId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer invalid-token-12345',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });

    it('should reject requests with malformed Authorization header with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?resourceId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'InvalidFormat token123',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });

    it('should reject requests without Bearer prefix with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?resourceId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'some-token-without-bearer',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      expect(body.error).toBeDefined();
    });
  });

  describe('Content Negotiation with Authentication', () => {
    it('should reject HTML requests without authentication', async () => {
      const res = await app.request('/resources/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      expect(res.status).toBe(401);
    });

    it('should reject JSON-LD requests without authentication', async () => {
      const res = await app.request('/resources/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/ld+json',
        },
      });

      expect(res.status).toBe(401);
    });

  });

  describe('Security Headers', () => {
    it('should not leak information about resource existence without authentication', async () => {
      const res = await app.request('/resources/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      // Should not say "Resource not found" - only "Unauthorized"
      expect(body.error.toLowerCase()).not.toContain('resource');
      expect(body.error.toLowerCase()).not.toContain('not found');
    });

    it('should not leak information about annotation existence without authentication', async () => {
      const res = await app.request('/annotations/anno-test-123?resourceId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json() as ErrorResponse;
      // Should not say "Annotation not found" - only "Unauthorized"
      expect(body.error.toLowerCase()).not.toContain('annotation');
      expect(body.error.toLowerCase()).not.toContain('not found');
    });
  });
});
