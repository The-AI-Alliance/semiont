/**
 * W3C URI Authentication Tests
 *
 * Tests that W3C-compliant URI endpoints require authentication
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';

type Variables = {
  user: User;
};

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

describe('W3C URI Authentication', () => {
  let app: Hono<{ Variables: Variables }>;

  beforeAll(async () => {
    // Set required environment variables before importing app
    process.env.BACKEND_URL = 'http://localhost:4000';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.FRONTEND_URL = 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    // Import the app
    const { app: importedApp } = await import('../index');
    app = importedApp;
  });

  describe('GET /documents/:id', () => {
    it('should reject unauthenticated requests with 401', async () => {
      const res = await app.request('/documents/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should reject requests with invalid token with 401', async () => {
      const res = await app.request('/documents/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer invalid-token-12345',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should reject requests with malformed Authorization header with 401', async () => {
      const res = await app.request('/documents/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'InvalidFormat token123',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should reject requests without Bearer prefix with 401', async () => {
      const res = await app.request('/documents/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'some-token-without-bearer',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('GET /annotations/:id', () => {
    it('should reject unauthenticated requests with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?documentId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should reject requests with invalid token with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?documentId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer invalid-token-12345',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should reject requests with malformed Authorization header with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?documentId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'InvalidFormat token123',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should reject requests without Bearer prefix with 401', async () => {
      const res = await app.request('/annotations/anno-test-123?documentId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'some-token-without-bearer',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('Content Negotiation with Authentication', () => {
    it('should reject HTML requests without authentication', async () => {
      const res = await app.request('/documents/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      expect(res.status).toBe(401);
    });

    it('should reject JSON-LD requests without authentication', async () => {
      const res = await app.request('/documents/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/ld+json',
        },
      });

      expect(res.status).toBe(401);
    });

  });

  describe('Security Headers', () => {
    it('should not leak information about document existence without authentication', async () => {
      const res = await app.request('/documents/doc-test-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      // Should not say "Document not found" - only "Unauthorized"
      expect(body.error?.toLowerCase()).not.toContain('document');
      expect(body.error?.toLowerCase()).not.toContain('not found');
    });

    it('should not leak information about annotation existence without authentication', async () => {
      const res = await app.request('/annotations/anno-test-123?documentId=doc-123', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      // Should not say "Annotation not found" - only "Unauthorized"
      expect(body.error?.toLowerCase()).not.toContain('annotation');
      expect(body.error?.toLowerCase()).not.toContain('not found');
    });
  });
});
