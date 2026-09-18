import { userId } from '@semiont/core';
import { email } from '@semiont/core';
/**
 * Integration tests for API endpoints
 * These tests make actual HTTP requests to test API functionality
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { Hono } from 'hono';
import type { User } from '@prisma/client';
import type { EnvironmentConfig, EventBus } from '@semiont/core';
import { loadEnvironmentConfig } from '@semiont/core/node';
import { JWTService } from '../../auth/jwt';

// Read straight off disk rather than from the __SEMIONT_VERSION__ define, so a
// build config that forgets the define is a test failure rather than a
// tautology that passes.
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(
    resolve(fileURLToPath(import.meta.url), '../../../../package.json'),
    'utf-8',
  ),
).version;

type Variables = {
  user: User;
  config: EnvironmentConfig;
  eventBus: EventBus;
};

// Delay app import until after test setup to avoid Prisma validation errors
let app: Hono<{ Variables: Variables }>;
// Local type definitions to replace api-contracts imports
interface HealthResponse {
  status: string;
  message: string;
  version: string;
  timestamp: string;
  database: string;
  environment: string;
}

interface OpenAPISpec {
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
  version: string;
  timestamp: string;
  database: 'connected' | 'disconnected' | 'unknown';
  environment: string;
}

interface StatusResponse {
  status: string;
  version: string;
  features: {
    semanticContent: string;
    collaboration: string;
    rbac: string;
  };
  message: string;
  authenticatedAs?: string;
}


interface UserResponse {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  domain: string;
  provider: string;
  isAdmin: boolean;
  isActive: boolean;
  termsAcceptedAt: string | null;
  lastLogin: string | null;
  created: string;
}


interface ErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
}

// Local test interfaces (removed unused ApiDocResponse)

interface TermsAcceptanceResponse {
  success: boolean;
  message: string;
  termsAcceptedAt: string;
}

interface AdminUsersResponse {
  success: boolean;
  users: UserResponse[];
}

interface AdminStatsResponse {
  success: boolean;
  stats: {
    total: number;
    active: number;
    admins: number;
    recent: number;
  };
}

// Removed unused AdminUserUpdateResponse and AdminUserDeleteResponse interfaces


vi.mock('../../identity/principal', () => ({
  principalFromToken: vi.fn(),
}));

// Create a shared mock client that tests can modify
const sharedMockClient = {
  $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    update: vi.fn(),
    delete: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
  },
};

// Mock database
vi.mock('../../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => sharedMockClient),
    checkHealth: vi.fn().mockResolvedValue(true),
  },
  prisma: sharedMockClient,
}));

// Create a test user for authenticated requests
const testUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  name: 'Test User',
  image: null,
  domain: 'example.com',
  provider: 'google',
  providerId: 'google-test-user-id',
  isAdmin: false,
  isModerator: false,
  isActive: true,
  termsAcceptedAt: new Date(),
  lastLogin: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Generate a test token for authenticated requests
let testToken: string;

// Mock configuration
vi.mock('../../config', () => ({
  CONFIG: {
    NODE_ENV: 'test',
    PORT: 3001,
    JWT_SECRET: 'test-jwt-secret',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    ADMIN_EMAIL: 'admin@example.com',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test_db',
    CORS_ORIGIN: 'http://localhost:3000',
  },
}));

describe('API Endpoints Integration Tests', () => {
  beforeAll(async () => {
    // Set required environment variables before importing app
    process.env.NODE_ENV = 'test';

    // Load config and initialize JWT Service.
    //
    // `null`, not SEMIONT_ROOT: the gateway mounts no knowledge base and reads
    // its whole config from ~/.semiontconfig — index.ts:48 loads exactly this
    // way. The fixture redirects HOME to its temp dir and writes the file
    // there, and `[environments.integration.site]` carries the `domain`
    // JWTService.initialize requires, so no project root is involved in reaching it.
    //
    // The SEMIONT_ROOT read this replaces outlived its requirement: both
    // gateway test setups stopped exporting the variable once nothing in
    // production read it (SINGLE-KB-MOUNT P5/P6), and the test-env hygiene
    // gate exists to stop tests fabricating deployment facts like that one.
    const config = loadEnvironmentConfig(null, 'integration');
    JWTService.initialize(config);

    // Import app after test setup has set DATABASE_URL to avoid Prisma validation errors
    const serverModule = await import('../../index');
    app = serverModule.app;

    // Generate a test token
    testToken = JWTService.generateToken({
      userId: userId(testUser.id),
      email: email(testUser.email),
      name: testUser.name,
      domain: testUser.domain,
      provider: testUser.provider,
      isAdmin: testUser.isAdmin,
    });
    
    // Mock the database to return our test user when queried
    const { DatabaseConnection } = await import('../../db');
    const prisma = DatabaseConnection.getClient();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(testUser as User);
    
    // Resolve the test token to the test user
    const { principalFromToken } = await import('../../identity/principal');
    vi.mocked(principalFromToken).mockImplementation(async (token) => {
      if (token === testToken || token === 'valid-jwt-token') {
        return { user: testUser as User };
      }
      throw new Error('Invalid token');
    });
  });

  describe('Protected Endpoints (Now Require Auth)', () => {
    it('GET /api/status should return 401 without auth', async () => {
      const res = await app.request('/api/status');
      expect(res.status).toBe(401);

      const data = await res.json() as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it('GET /api/status should return service status with auth', async () => {
      const res = await app.request('/api/status', {
        headers: {
          'Authorization': `Bearer ${testToken}`,
        },
      });
      expect(res.status).toBe(200);

      const data = await res.json() as StatusResponse;
      expect(data.message).toBe('Ready to build the future of knowledge management!');
      expect(data.status).toBe('operational');
      expect(data.version).toBe(PACKAGE_VERSION);
      expect(data.authenticatedAs).toBe('test@example.com');
    });



    it('GET /api/status should return 401 without auth', async () => {
      const res = await app.request('/api/status');
      expect(res.status).toBe(401);
    });

    it('GET /api/status should return status information with auth', async () => {
      const res = await app.request('/api/status', {
        headers: {
          'Authorization': `Bearer ${testToken}`,
        },
      });
      expect(res.status).toBe(200);
      
      const data = await res.json() as StatusResponse;
      expect(data.status).toBe('operational');
      expect(data.version).toBe(PACKAGE_VERSION);
      expect(data.features).toEqual({
        semanticContent: 'planned',
        collaboration: 'planned',
        rbac: 'planned',
      });
      expect(data.message).toBe('Ready to build the future of knowledge management!');
      expect(data.authenticatedAs).toBe(testUser.email);
    });
  });

  describe('Public Endpoints (No Auth Required)', () => {
    it('GET /api/health should return health status without auth', async () => {
      // Mock successful database query
      const { prisma } = await import('../../db');
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);
      
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      
      const data = await res.json() as HealthResponse;
      expect(data.status).toBe('operational');
      expect(data.message).toBe('Semiont API is running');
      expect(data.version).toBe(PACKAGE_VERSION);
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(data.database).toBe('connected');
      expect(data.environment).toBeDefined();
    });

    it('GET /api/health should handle database errors', async () => {
      // Mock database health check failure
      const { DatabaseConnection } = await import('../../db');
      vi.mocked(DatabaseConnection.checkHealth).mockResolvedValue(false);

      const res = await app.request('/api/health');
      expect(res.status).toBe(200);

      const data = await res.json() as HealthResponse;
      expect(data.status).toBe('operational');
      expect(data.database).toBe('disconnected');
    });


    it('GET /api/openapi.json should return OpenAPI specification', async () => {
      const res = await app.request('/api/openapi.json');
      expect(res.status).toBe(200);

      const data = await res.json() as OpenAPISpec;
      expect(data.info).toBeDefined();
      expect(data.info.title).toBe('Semiont API');
      // The served spec reports the running build, not the spec file's
      // placeholder — see the info stamp in index.ts.
      expect(data.info.version).toBe(PACKAGE_VERSION);
      expect(data.paths).toBeDefined();
      expect(data.components).toBeDefined();
    });

    it('GET /api/docs should return HTML resourceation', async () => {
      const res = await app.request('/api/docs');
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('swagger-ui');
    });
  });

  describe('Protected Endpoints', () => {
    const mockUser = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      image: 'https://example.com/avatar.jpg',
      domain: 'example.com',
      provider: 'google',
      providerId: 'google-123',
      isAdmin: false,
      isModerator: false,
      isActive: true,
      termsAcceptedAt: new Date(),
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(async () => {
      // Mock successful token verification for protected routes
      const { principalFromToken } = await import('../../identity/principal');
      vi.mocked(principalFromToken).mockImplementation(async (token) => {
        if (token === 'valid-jwt-token') {
          return { user: mockUser as User };
        }
        throw new Error('Invalid token');
      });
    });

    it('GET /api/users/me should return user info with valid token', async () => {
      const res = await app.request('/api/users/me', {
        headers: {
          'Authorization': 'Bearer valid-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as UserResponse;
      expect(data.id).toBe('user-123');
      expect(data.email).toBe('test@example.com');
      expect(data.name).toBe('Test User');
      expect(data.isAdmin).toBe(false);
      expect(data.isActive).toBe(true);
    });

    it('GET /api/users/me should fail without token', async () => {
      const res = await app.request('/api/users/me');
      expect(res.status).toBe(401);
      
      const data = await res.json() as ErrorResponse;
      expect(data.error).toBe('Unauthorized');
    });

    it('GET /api/users/me should fail with invalid token', async () => {
      const { principalFromToken } = await import('../../identity/principal');
      vi.mocked(principalFromToken).mockRejectedValue(new Error('Invalid token'));

      const res = await app.request('/api/users/me', {
        headers: {
          'Authorization': 'Bearer invalid-token',
        },
      });

      expect(res.status).toBe(401);
      const data = await res.json() as ErrorResponse;
      expect(data.error).toContain('token');
    });

    it('POST /api/users/accept-terms should update terms acceptance', async () => {
      sharedMockClient.user.update.mockResolvedValue({ ...mockUser, termsAcceptedAt: new Date() } as User);

      const res = await app.request('/api/users/accept-terms', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as TermsAcceptanceResponse;
      expect(data.success).toBe(true);
      expect(data.message).toBe('Terms accepted');
    });
  });

  describe('Admin Endpoints', () => {
    const mockAdminUser = {
      id: 'admin-123',
      email: 'admin@example.com',
      name: 'Admin User',
      image: null,
      domain: 'example.com',
      provider: 'google',
      providerId: 'google-admin-123',
      isAdmin: true,
      isModerator: true,
      isActive: true,
      termsAcceptedAt: new Date(),
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockRegularUser = {
      id: 'user-123',
      email: 'user@example.com',
      name: 'Regular User',
      image: null,
      domain: 'example.com',
      provider: 'google',
      providerId: 'google-user-123',
      isAdmin: false,
      isModerator: false,
      isActive: true,
      termsAcceptedAt: new Date(),
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(async () => {
      vi.clearAllMocks();

      // Re-arm the principal mock for each test
      const { principalFromToken } = await import('../../identity/principal');
      vi.mocked(principalFromToken).mockImplementation(async (token) => {
        if (token === 'admin-jwt-token') {
          return { user: mockAdminUser as User };
        } else if (token === 'regular-jwt-token') {
          return { user: mockRegularUser as User };
        }
        throw new Error('Invalid token');
      });
    });

    it('GET /api/admin/users should return users list for admin', async () => {
      // Use the shared mock client directly
      sharedMockClient.user.findMany.mockResolvedValueOnce([mockAdminUser, mockRegularUser]);

      const res = await app.request('/api/admin/users', {
        headers: {
          'Authorization': 'Bearer admin-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as AdminUsersResponse;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.users)).toBe(true);
      expect(data.users).toHaveLength(2);
    });

    it('GET /api/admin/users should fail for non-admin user', async () => {

      const res = await app.request('/api/admin/users', {
        headers: {
          'Authorization': 'Bearer regular-jwt-token',
        },
      });

      expect(res.status).toBe(403);
      const data = await res.json() as ErrorResponse;
      expect(data.error).toBe('Forbidden: Admin access required');
    });

    it('GET /api/admin/users/stats should return user statistics', async () => {
      // Use the shared mock client directly
      sharedMockClient.user.count
        .mockResolvedValueOnce(10) // total users
        .mockResolvedValueOnce(8)  // active users
        .mockResolvedValueOnce(2)  // admin users
        .mockResolvedValueOnce(3); // recent users

      // Mock groupBy for domain stats
      sharedMockClient.user.groupBy.mockResolvedValueOnce([
        { domain: 'example.com', _count: { domain: 5 } },
        { domain: 'test.com', _count: { domain: 3 } }
      ]);

      const res = await app.request('/api/admin/users/stats', {
        headers: {
          'Authorization': 'Bearer admin-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as AdminStatsResponse;
      expect(data.success).toBe(true);
      expect(data.stats).toEqual({
        totalUsers: 10,
        activeUsers: 8,
        adminUsers: 2,
        regularUsers: expect.any(Number),
        recentSignups: expect.any(Array),
        domainBreakdown: expect.any(Array),
      });
    });



  });

  describe('Error Handling', () => {
    it('should handle 404 for non-existent endpoints', async () => {
      const res = await app.request('/api/nonexistent');
      expect(res.status).toBe(404);
    });

    it('should handle malformed JSON in request body', async () => {
      // The agent route is the one public POST; it answers 503 without its secret.
      const priorSecret = process.env.SEMIONT_WORKER_SECRET;
      process.env.SEMIONT_WORKER_SECRET = 'api-endpoints-worker-secret';
      try {
        const res = await app.request('/api/tokens/agent', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: '{invalid json',
        });

        expect(res.status).toBe(400);
      } finally {
        if (priorSecret === undefined) delete process.env.SEMIONT_WORKER_SECRET;
        else process.env.SEMIONT_WORKER_SECRET = priorSecret;
      }
    });

  });
});