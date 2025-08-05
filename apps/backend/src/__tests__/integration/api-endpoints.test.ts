/**
 * Integration tests for API endpoints
 * These tests make actual HTTP requests to test API functionality
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { app } from '../../index';
import type {
  HelloResponse,
  StatusResponse,
  HealthResponse,
  AuthResponse,
  UserResponse,
  LogoutResponse,
  ErrorResponse,
} from '@semiont/api-types';


// Mock the entire auth/oauth module to avoid external API calls
vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    verifyGoogleToken: vi.fn(),
    createOrUpdateUser: vi.fn(),
    getUserFromToken: vi.fn(),
  },
}));

// Mock database
vi.mock('../../db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

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
  describe('Public Endpoints', () => {
    it('GET /api/hello should return greeting', async () => {
      const res = await app.request('/api/hello');
      expect(res.status).toBe(200);
      
      const data: HelloResponse = await res.json();
      expect(data.message).toBe('Hello, World! Welcome to Semiont.');
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(data.platform).toBe('Semiont Semantic Knowledge Platform');
    });

    it('GET /api/hello/John should return personalized greeting', async () => {
      const res = await app.request('/api/hello/John');
      expect(res.status).toBe(200);
      
      const data: HelloResponse = await res.json();
      expect(data.message).toBe('Hello, John! Welcome to Semiont.');
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(data.platform).toBe('Semiont Semantic Knowledge Platform');
    });

    it('GET /api/hello with very long name should fail validation', async () => {
      const longName = 'a'.repeat(101); // 101 characters
      const res = await app.request(`/api/hello/${longName}`);
      expect(res.status).toBe(400);
      
      const data: ErrorResponse = await res.json();
      expect(data.error).toBe('Invalid parameters');
      expect(data.details).toBeDefined();
    });

    it('GET /api/status should return status information', async () => {
      const res = await app.request('/api/status');
      expect(res.status).toBe(200);
      
      const data: StatusResponse = await res.json();
      expect(data.status).toBe('operational');
      expect(data.version).toBe('0.1.0');
      expect(data.features).toEqual({
        semanticContent: 'planned',
        collaboration: 'planned',
        rbac: 'planned',
      });
      expect(data.message).toBe('Ready to build the future of knowledge management!');
    });

    it('GET /api/health should return health status', async () => {
      // Mock successful database query
      const { prisma } = await import('../../db');
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);
      
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      
      const data: HealthResponse = await res.json();
      expect(data.status).toBe('operational');
      expect(data.message).toBe('Semiont API is running');
      expect(data.version).toBe('0.1.0');
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(data.database).toBe('connected');
      expect(data.environment).toBeDefined();
    });

    it('GET /api/health should handle database errors', async () => {
      // Mock database query failure
      const { prisma } = await import('../../db');
      vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error('Database connection failed'));
      
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      
      const data: HealthResponse = await res.json();
      expect(data.status).toBe('operational');
      expect(data.database).toBe('disconnected');
    });


    it('GET /api should return API documentation (JSON)', async () => {
      const res = await app.request('/api', {
        headers: {
          'Accept': 'application/json',
        },
      });
      expect(res.status).toBe(200);
      
      const data = await res.json();
      expect(data.name).toBe('Semiont API');
      expect(data.version).toBe('0.1.0');
      expect(data.description).toBe('REST API for the Semiont Semantic Knowledge Platform');
      expect(data.endpoints).toBeDefined();
      expect(data.endpoints.public).toBeDefined();
      expect(data.endpoints.auth).toBeDefined();
      expect(data.endpoints.admin).toBeDefined();
    });

    it('GET /api should return HTML documentation for browsers', async () => {
      const res = await app.request('/api', {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
      });
      expect(res.status).toBe(200);
      
      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Semiont API Documentation');
      expect(html).toContain('<strong>Version:</strong> 0.1.0');
    });
  });

  describe('Authentication Endpoints', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('POST /api/auth/google should authenticate with valid token', async () => {
      const { OAuthService } = await import('../../auth/oauth');
      
      // Mock successful OAuth flow
      vi.mocked(OAuthService.verifyGoogleToken).mockResolvedValue({
        id: 'google-123',
        email: 'test@example.com',
        verified_email: true,
        name: 'Test User',
        picture: 'https://example.com/avatar.jpg',
        locale: 'en',
      });
      
      vi.mocked(OAuthService.createOrUpdateUser).mockResolvedValue({
        user: {
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          image: 'https://example.com/avatar.jpg',
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
          isActive: true,
          termsAcceptedAt: null,
          lastLogin: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        token: 'mock-jwt-token',
        isNewUser: false,
      });

      const res = await app.request('/api/auth/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'valid-google-token',
        }),
      });

      expect(res.status).toBe(200);
      const data: AuthResponse = await res.json();
      expect(data.success).toBe(true);
      expect(data.user.email).toBe('test@example.com');
      expect(data.token).toBe('mock-jwt-token');
      expect(data.isNewUser).toBe(false);
    });

    it('POST /api/auth/google should fail with invalid token', async () => {
      const { OAuthService } = await import('../../auth/oauth');
      
      // Mock OAuth failure
      vi.mocked(OAuthService.verifyGoogleToken).mockRejectedValue(
        new Error('Invalid token')
      );

      const res = await app.request('/api/auth/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'invalid-token',
        }),
      });

      expect(res.status).toBe(400);
      const data: ErrorResponse = await res.json();
      expect(data.error).toBe('Invalid token');
    });

    it('POST /api/auth/google should fail with missing token', async () => {
      const res = await app.request('/api/auth/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data: ErrorResponse = await res.json();
      expect(data.error).toBe('Invalid request body');
      expect(data.details).toBeDefined();
    });

    it('POST /api/auth/google should fail with invalid JSON', async () => {
      const res = await app.request('/api/auth/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: 'invalid-json',
      });

      expect(res.status).toBe(400);
      const data: ErrorResponse = await res.json();
      expect(data.error).toContain('invalid-json');
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
      isAdmin: false,
      isActive: true,
      termsAcceptedAt: new Date(),
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      // Mock successful token verification for protected routes
      OAuthService.getUserFromToken.mockResolvedValue(mockUser);
    });

    it('GET /api/auth/me should return user info with valid token', async () => {
      const res = await app.request('/api/auth/me', {
        headers: {
          'Authorization': 'Bearer valid-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data: UserResponse = await res.json();
      expect(data.id).toBe('user-123');
      expect(data.email).toBe('test@example.com');
      expect(data.name).toBe('Test User');
      expect(data.isAdmin).toBe(false);
      expect(data.isActive).toBe(true);
    });

    it('GET /api/auth/me should fail without token', async () => {
      const res = await app.request('/api/auth/me');
      expect(res.status).toBe(401);
      
      const data: ErrorResponse = await res.json();
      expect(data.error).toBe('Unauthorized');
    });

    it('GET /api/auth/me should fail with invalid token', async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      OAuthService.getUserFromToken.mockRejectedValue(new Error('Invalid token'));

      const res = await app.request('/api/auth/me', {
        headers: {
          'Authorization': 'Bearer invalid-token',
        },
      });

      expect(res.status).toBe(401);
      const data: ErrorResponse = await res.json();
      expect(data.error).toContain('token');
    });

    it('POST /api/auth/logout should return success', async () => {
      const res = await app.request('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data: LogoutResponse = await res.json();
      expect(data.success).toBe(true);
      expect(data.message).toBe('Logged out successfully');
    });

    it('POST /api/auth/accept-terms should update terms acceptance', async () => {
      const { prisma } = await import('../../db');
      const updatedUser = { ...mockUser, termsAcceptedAt: new Date() };
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser);

      const res = await app.request('/api/auth/accept-terms', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer valid-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.message).toBe('Terms accepted successfully');
      expect(data.termsAcceptedAt).toBeDefined();
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
      isAdmin: true,
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
      isAdmin: false,
      isActive: true,
      termsAcceptedAt: new Date(),
      lastLogin: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('GET /api/admin/users should return users list for admin', async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      const { prisma } = await import('../../db');
      
      // Mock admin authentication
      OAuthService.getUserFromToken.mockResolvedValue(mockAdminUser);
      
      // Mock database query
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockAdminUser, mockRegularUser]);

      const res = await app.request('/api/admin/users', {
        headers: {
          'Authorization': 'Bearer admin-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.users)).toBe(true);
      expect(data.users).toHaveLength(2);
    });

    it('GET /api/admin/users should fail for non-admin user', async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      
      // Mock regular user authentication
      OAuthService.getUserFromToken.mockResolvedValue(mockRegularUser);

      const res = await app.request('/api/admin/users', {
        headers: {
          'Authorization': 'Bearer regular-jwt-token',
        },
      });

      expect(res.status).toBe(403);
      const data: ErrorResponse = await res.json();
      expect(data.error).toBe('Admin access required');
    });

    it('GET /api/admin/users/stats should return user statistics', async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      const { prisma } = await import('../../db');
      
      // Mock admin authentication
      OAuthService.getUserFromToken.mockResolvedValue(mockAdminUser);
      
      // Mock database queries
      vi.mocked(prisma.user.count)
        .mockResolvedValueOnce(10) // total users
        .mockResolvedValueOnce(8)  // active users
        .mockResolvedValueOnce(2)  // admin users
        .mockResolvedValueOnce(3); // recent users

      const res = await app.request('/api/admin/users/stats', {
        headers: {
          'Authorization': 'Bearer admin-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.stats).toEqual({
        total: 10,
        active: 8,
        admins: 2,
        recent: 3,
      });
    });

    it('PATCH /api/admin/users/:id should update user', async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      const { prisma } = await import('../../db');
      
      // Mock admin authentication
      OAuthService.getUserFromToken.mockResolvedValue(mockAdminUser);
      
      // Mock database queries
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockRegularUser);
      const updatedUser = { ...mockRegularUser, isAdmin: true };
      vi.mocked(prisma.user.update).mockResolvedValue(updatedUser);

      const res = await app.request('/api/admin/users/user-123', {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer admin-jwt-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isAdmin: true,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.user.isAdmin).toBe(true);
    });

    it('DELETE /api/admin/users/:id should delete user', async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      const { prisma } = await import('../../db');
      
      // Mock admin authentication
      OAuthService.getUserFromToken.mockResolvedValue(mockAdminUser);
      
      // Mock database queries
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockRegularUser);
      vi.mocked(prisma.user.delete).mockResolvedValue(mockRegularUser);

      const res = await app.request('/api/admin/users/user-123', {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer admin-jwt-token',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.message).toBe('User deleted successfully');
    });

    it('DELETE /api/admin/users/:id should prevent self-deletion', async () => {
      const { OAuthService } = vi.mocked(await import('../../auth/oauth'));
      
      // Mock admin authentication
      OAuthService.getUserFromToken.mockResolvedValue(mockAdminUser);

      const res = await app.request('/api/admin/users/admin-123', {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer admin-jwt-token',
        },
      });

      expect(res.status).toBe(400);
      const data: ErrorResponse = await res.json();
      expect(data.error).toBe('Cannot delete your own account');
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for non-existent endpoints', async () => {
      const res = await app.request('/api/nonexistent');
      expect(res.status).toBe(404);
    });

    it('should handle malformed JSON in request body', async () => {
      const res = await app.request('/api/auth/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{invalid json',
      });

      expect(res.status).toBe(400);
    });

    it('should handle missing Content-Type header', async () => {
      const res = await app.request('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ access_token: 'test' }),
      });

      // Should still work - Hono handles this gracefully
      expect(res.status).toBe(400); // Will fail validation, but not due to missing header
    });
  });
});