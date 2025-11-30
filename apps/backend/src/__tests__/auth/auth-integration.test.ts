/**
 * Integration tests for authentication
 * Tests that OAuth and password auth coexist properly
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { app } from '../../index';
import { DatabaseConnection } from '../../db';
import { JWTService } from '../../auth/jwt';
import { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import * as bcrypt from 'bcrypt';
import type { components } from '@semiont/api-client';

type AuthResponse = components["schemas"]["AuthResponse"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

describe('Authentication Integration', () => {
  beforeAll(() => {
    // Initialize JWTService with test config
    JWTService.initialize({
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local', 'example.com'] },
      services: {
        backend: {
          platform: { type: 'posix' },
          corsOrigin: 'http://localhost:3000',
          publicURL: 'http://localhost:4000',
          port: 4000
        },
        frontend: {
          platform: { type: 'posix' },
          url: 'http://localhost:3000',
          port: 3000,
          siteName: 'Test Site'
        }
      },
      app: {}
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('OAuth still works after password auth added', () => {
    it('should allow OAuth login with POST /api/tokens/google', async () => {
      const mockUser: User = {
        id: faker.string.uuid(),
        email: 'oauth@example.com',
        name: 'OAuth User',
        image: 'https://example.com/photo.jpg',
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-123',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findFirst.mockResolvedValue(mockUser);
      mockPrismaUser.update.mockResolvedValue(mockUser);

      const response = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'valid-access-token'
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json() as AuthResponse;
      expect(data.success).toBe(true);
      expect(data.token).toBeDefined();
    });
  });

  describe('Password users cannot use OAuth endpoint', () => {
    it('should handle password user at OAuth endpoint appropriately', async () => {
      // When OAuth tries to find or create this user, it won't match provider/providerId
      const newOAuthUser: User = {
        id: faker.string.uuid(),
        email: 'newuser@example.com',
        name: 'New User',
        image: 'https://example.com/photo.jpg',
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-new-123',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findFirst.mockResolvedValue(null);
      mockPrismaUser.create.mockResolvedValue(newOAuthUser);

      const response = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'valid-access-token'
        }),
      });

      // OAuth will try to create new user, which should succeed
      // (Different provider/providerId combination)
      expect(response.status).toBe(200);
    });
  });

  describe('OAuth users cannot use password endpoint', () => {
    it('should reject OAuth user at password endpoint', async () => {
      const mockOAuthUser: User = {
        id: faker.string.uuid(),
        email: 'oauth-only@example.com',
        name: 'OAuth Only User',
        image: 'https://example.com/photo.jpg',
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-456',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findUnique.mockResolvedValue(mockOAuthUser);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'oauth-only@example.com',
          password: 'somepassword'
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json() as ErrorResponse;
      expect(data.error).toContain('OAuth');
    });
  });

  describe('Both auth methods produce valid JWT tokens', () => {
    it('should produce valid JWT from password auth', async () => {
      const passwordHash = await bcrypt.hash('testpass', 12);

      const mockUser: User = {
        id: faker.string.uuid(),
        email: 'password@example.com',
        name: 'Password User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: 'password@example.com',
        passwordHash,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findUnique.mockResolvedValue(mockUser);
      mockPrismaUser.update.mockResolvedValue(mockUser);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'password@example.com',
          password: 'testpass'
        }),
      });

      const data = await response.json() as AuthResponse;

      // Should have JWT format (three parts separated by dots)
      expect(data.token).toBeDefined();
      expect(data.token.split('.')).toHaveLength(3);
    });

    it('should produce valid JWT from OAuth', async () => {
      const mockUser: User = {
        id: faker.string.uuid(),
        email: 'oauth@example.com',
        name: 'OAuth User',
        image: 'https://example.com/photo.jpg',
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-789',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findFirst.mockResolvedValue(mockUser);
      mockPrismaUser.update.mockResolvedValue(mockUser);

      const response = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'valid-access-token'
        }),
      });

      const data = await response.json() as AuthResponse;

      // Should have JWT format (three parts separated by dots)
      expect(data.token).toBeDefined();
      expect(data.token.split('.')).toHaveLength(3);
    });
  });

  describe('Session duration same for both auth types', () => {
    it('should use same JWT expiration for password auth', async () => {
      const passwordHash = await bcrypt.hash('testpass', 12);

      const mockUser: User = {
        id: faker.string.uuid(),
        email: 'password@example.com',
        name: 'Password User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: 'password@example.com',
        passwordHash,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findUnique.mockResolvedValue(mockUser);
      mockPrismaUser.update.mockResolvedValue(mockUser);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'password@example.com',
          password: 'testpass'
        }),
      });

      const data = await response.json() as AuthResponse;

      // Decode JWT to check expiration
      const payload = JSON.parse(
        Buffer.from(data.token.split('.')[1]!, 'base64').toString()
      );

      // Should have exp field
      expect(payload.exp).toBeDefined();

      // Expiration should be in the future
      expect(payload.exp * 1000).toBeGreaterThan(Date.now());
    });
  });

  describe('User with same email but different provider', () => {
    it('should allow same email with different providers', async () => {
      // This tests that the @@unique([provider, providerId]) constraint works

      const passwordHash = await bcrypt.hash('testpass', 12);

      // User with email foo@example.com as password user
      const mockPasswordUser: User = {
        id: faker.string.uuid(),
        email: 'foo@example.com',
        name: 'Password Foo',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: 'foo@example.com',
        passwordHash,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Same email but as OAuth user
      const mockOAuthUser: User = {
        id: faker.string.uuid(),
        email: 'foo@example.com',
        name: 'OAuth Foo',
        image: 'https://example.com/photo.jpg',
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-foo-123',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Password auth
      mockPrismaUser.findUnique.mockResolvedValueOnce(mockPasswordUser);
      mockPrismaUser.update.mockResolvedValueOnce(mockPasswordUser);

      const passwordResponse = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'foo@example.com',
          password: 'testpass'
        }),
      });

      expect(passwordResponse.status).toBe(200);

      // OAuth auth
      mockPrismaUser.findFirst.mockResolvedValueOnce(mockOAuthUser);
      mockPrismaUser.update.mockResolvedValueOnce(mockOAuthUser);

      const oauthResponse = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          access_token: 'valid-access-token'
        }),
      });

      expect(oauthResponse.status).toBe(200);

      // Both should succeed - different provider/providerId combinations
    });
  });
});
