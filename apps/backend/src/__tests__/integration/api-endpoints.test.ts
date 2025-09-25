/**
 * Integration tests for API endpoints
 * These tests make actual HTTP requests to test API functionality
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { User } from '@prisma/client';
import { JWTService } from '../../auth/jwt';

type Variables = {
  user: User;
};

// Delay app import until after test setup to avoid Prisma validation errors
let app: OpenAPIHono<{ Variables: Variables }>;
import type {
  HealthResponse,
  StatusResponse,
  AuthResponse,
  UserResponse,
  LogoutResponse,
  ErrorResponse,
} from '@semiont/api-contracts';

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


// Mock the entire auth/oauth module to avoid external API calls
vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    verifyGoogleToken: vi.fn(),
    createOrUpdateUser: vi.fn(),
    getUserFromToken: vi.fn(),
    acceptTerms: vi.fn(),
  },
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
    FRONTEND_URL: 'http://localhost:3000',
    CORS_ORIGIN: 'http://localhost:3000',
  },
}));

describe('API Endpoints Integration Tests', () => {
  beforeAll(async () => {
    // Import app after test setup has set DATABASE_URL to avoid Prisma validation errors
    const serverModule = await import('../../index');
    app = serverModule.app;
    
    // Generate a test token
    testToken = JWTService.generateToken({
      userId: testUser.id,
      email: testUser.email,
      name: testUser.name,
      domain: testUser.domain,
      provider: testUser.provider,
      isAdmin: testUser.isAdmin,
    });
    
    // Mock the database to return our test user when queried
    const { DatabaseConnection } = await import('../../db');
    const prisma = DatabaseConnection.getClient();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(testUser as any);
    
    // Mock OAuthService to return test user for the test token
    const { OAuthService } = await import('../../auth/oauth');
    vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) => {
      if (token === testToken || token === 'valid-jwt-token') {
        return testUser as any;
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
      expect(data.version).toBe('0.1.0');
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
      expect(data.version).toBe('0.1.0');
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
      expect(data.version).toBe('0.1.0');
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

      const data = await res.json() as any;
      expect(data.info).toBeDefined();
      expect(data.info.title).toBe('Semiont API');
      expect(data.info.version).toBe('0.1.0');
      expect(data.paths).toBeDefined();
      expect(data.components).toBeDefined();
    });

    it('GET /api/docs should return HTML documentation', async () => {
      const res = await app.request('/api/docs');
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('swagger-ui');
    });
  });

  describe('Authentication Endpoints', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('POST /api/tokens/google should authenticate with valid token', async () => {
      const { OAuthService } = await import('../../auth/oauth');
      
      // Mock successful OAuth flow
      vi.mocked(OAuthService.verifyGoogleToken).mockResolvedValue({
        id: 'google-123',
        email: 'test@example.com',
        verified_email: true,
        name: 'Test User',
        picture: 'https://example.com/avatar.jpg',
        // locale: 'en', // Not part of GoogleUserInfo type
      });
      
      vi.mocked(OAuthService.createOrUpdateUser).mockResolvedValue({
        user: {
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
          termsAcceptedAt: null,
          lastLogin: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        token: 'mock-jwt-token',
        isNewUser: false,
      });

      const res = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'valid-google-token',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as AuthResponse;
      expect(data.success).toBe(true);
      expect(data.user.email).toBe('test@example.com');
      expect(data.token).toBe('mock-jwt-token');
      expect(data.isNewUser).toBe(false);
    });

    it('POST /api/tokens/google should fail with invalid token', async () => {
      const { OAuthService } = await import('../../auth/oauth');
      
      // Mock OAuth failure
      vi.mocked(OAuthService.verifyGoogleToken).mockRejectedValue(
        new Error('Invalid token')
      );

      const res = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'invalid-token',
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json() as ErrorResponse;
      expect(data.error).toBe('Invalid token');
    });

    it('POST /api/tokens/google should fail with missing token', async () => {
      const res = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      // The response contains ZodError instead of formatted validation error
      const responseText = await res.text();
      expect(responseText).toContain('access_token');
    });

    it('POST /api/tokens/google should fail with invalid JSON', async () => {
      const res = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: 'invalid-json',
      });

      expect(res.status).toBe(400);
      const responseText = await res.text();
      // Response should be valid, but may contain different error format
      expect(responseText).toBeDefined();
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
      const { OAuthService } = await import('../../auth/oauth');
      vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) => {
        if (token === 'valid-jwt-token') {
          return mockUser as any;
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
      const { OAuthService } = await import('../../auth/oauth');
      vi.mocked(OAuthService.getUserFromToken).mockRejectedValue(new Error('Invalid token'));

      const res = await app.request('/api/users/me', {
        headers: {
          'Authorization': 'Bearer invalid-token',
        },
      });

      expect(res.status).toBe(401);
      const data = await res.json() as ErrorResponse;
      expect(data.error).toContain('token');
    });

    it('POST /api/users/logout should return success', async () => {
      const res = await app.request('/api/users/logout', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as LogoutResponse;
      expect(data.success).toBe(true);
      expect(data.message).toBe('Logged out successfully');
    });

    it('POST /api/users/accept-terms should update terms acceptance', async () => {
      const { OAuthService } = await import('../../auth/oauth');
      const updatedUser = { ...mockUser, termsAcceptedAt: new Date() };
      vi.mocked(OAuthService.acceptTerms).mockResolvedValue(updatedUser as any);

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

      // Re-setup the OAuth mock for each test
      const { OAuthService } = await import('../../auth/oauth');
      vi.mocked(OAuthService.getUserFromToken).mockImplementation(async (token) => {
        if (token === 'admin-jwt-token') {
          return mockAdminUser as any;
        } else if (token === 'regular-jwt-token') {
          return mockRegularUser as any;
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
      const res = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{invalid json',
      });

      expect(res.status).toBe(400);
    });

    it('should handle missing Content-Type header', async () => {
      const res = await app.request('/api/tokens/google', {
        method: 'POST',
        body: JSON.stringify({ access_token: 'test' }),
      });

      // Should still work - Hono handles this gracefully
      expect(res.status).toBe(400); // Will fail validation, but not due to missing header
    });
  });
});