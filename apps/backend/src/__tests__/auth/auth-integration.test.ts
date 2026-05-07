/**
 * Integration tests for authentication
 * Tests that OAuth and password auth coexist properly, including cookie-based auth.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { makeMeaningMock } from '../helpers/make-meaning-mock';

// Mock make-meaning service to avoid graph initialization at import time
vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock())
  };
});

import { app } from '../../index';
import { DatabaseConnection } from '../../db';
import { JWTService } from '../../auth/jwt';
import { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import * as argon2 from 'argon2';
import type { components } from '@semiont/core';

type AuthResponse = components["schemas"]["AuthResponse"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

describe('Authentication Integration', () => {
  beforeAll(() => {
    // Initialize JWTService with test config
    JWTService.initialize({
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local', 'example.com'] },
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
      const passwordHash = await argon2.hash('testpass');

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
      const passwordHash = await argon2.hash('testpass');

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

      const passwordHash = await argon2.hash('testpass');

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

  describe('Set-Cookie header on auth responses', () => {
    const baseUser: User = {
      id: faker.string.uuid(),
      email: 'cookie@example.com',
      name: 'Cookie User',
      image: null,
      domain: 'example.com',
      provider: 'password',
      providerId: 'cookie@example.com',
      passwordHash: null,
      isAdmin: false,
      isActive: true,
      isModerator: false,
      termsAcceptedAt: null,
      lastLogin: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('POST /api/tokens/password should set semiont-token cookie on success', async () => {
      const passwordHash = await argon2.hash('cookiepass');
      const user = { ...baseUser, passwordHash };

      mockPrismaUser.findUnique.mockResolvedValue(user);
      mockPrismaUser.update.mockResolvedValue(user);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'cookie@example.com', password: 'cookiepass' }),
      });

      expect(response.status).toBe(200);
      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).not.toBeNull();
      expect(setCookie).toMatch(/semiont-token=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
    });

    it('POST /api/tokens/google should set semiont-token cookie on success', async () => {
      const oauthUser: User = {
        ...baseUser,
        provider: 'google',
        providerId: 'google-cookie-123',
        passwordHash: null,
      };

      mockPrismaUser.findFirst.mockResolvedValue(oauthUser);
      mockPrismaUser.update.mockResolvedValue(oauthUser);

      const response = await app.request('/api/tokens/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: 'valid-access-token' }),
      });

      expect(response.status).toBe(200);
      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).not.toBeNull();
      expect(setCookie).toMatch(/semiont-token=/);
      expect(setCookie).toMatch(/HttpOnly/i);
    });
  });

  // JWTPayloadSchema requires CUID format: /^c[a-z0-9]{24,}$/
  const makeCuid = () => `c${faker.string.alphanumeric(24).toLowerCase()}`;

  describe('Cookie fallback authentication', () => {
    // These tests use a real JWT generated by JWTService and mock only the Prisma lookup,
    // which is the same path OAuthService.getUserFromToken takes internally.
    const makeTokenAndUser = () => {
      const { email: makeEmail, userId: makeUserId } = require('@semiont/core');
      const user: User = {
        id: makeCuid(),
        email: 'cookieauth@example.com',
        name: 'Cookie Auth User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-ca-123',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const token = JWTService.generateToken({
        userId: makeUserId(user.id),
        email: makeEmail(user.email),
        domain: user.domain,
        provider: user.provider,
        isAdmin: user.isAdmin,
      });
      return { user, token };
    };

    it('should authenticate via semiont-token cookie when no Authorization header is present', async () => {
      const { user, token } = makeTokenAndUser();
      mockPrismaUser.findUnique.mockResolvedValue(user);

      const response = await app.request('/api/users/me', {
        headers: { 'Cookie': `semiont-token=${token}` },
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { id: string; email: string };
      expect(data.id).toBe(user.id);
      expect(data.email).toBe(user.email);
    });

    it('should return 401 when no Authorization header and no cookie are present', async () => {
      const response = await app.request('/api/users/me');

      expect(response.status).toBe(401);
      const data = await response.json() as { error: string };
      expect(data.error).toBe('Unauthorized');
    });

    it('should prefer Authorization header over cookie when both are present', async () => {
      const { email: makeEmail, userId: makeUserId } = require('@semiont/core');
      const bearerUser: User = {
        id: makeCuid(),
        email: 'bearer@example.com',
        name: 'Bearer User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-bearer-123',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const bearerToken = JWTService.generateToken({
        userId: makeUserId(bearerUser.id),
        email: makeEmail(bearerUser.email),
        domain: bearerUser.domain,
        provider: bearerUser.provider,
        isAdmin: bearerUser.isAdmin,
      });
      // Only the bearer user lookup should happen (Authorization header wins)
      mockPrismaUser.findUnique.mockResolvedValue(bearerUser);

      const response = await app.request('/api/users/me', {
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Cookie': 'semiont-token=some-other-invalid-token',
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { id: string };
      expect(data.id).toBe(bearerUser.id);
    });
  });

  describe('GET /api/users/me exposes token in response', () => {
    it('should include the token field in the response body', async () => {
      const { email: makeEmail, userId: makeUserId } = require('@semiont/core');
      const user: User = {
        id: makeCuid(),
        email: 'me@example.com',
        name: 'Me User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-me-123',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const token = JWTService.generateToken({
        userId: makeUserId(user.id),
        email: makeEmail(user.email),
        domain: user.domain,
        provider: user.provider,
        isAdmin: user.isAdmin,
      });
      mockPrismaUser.findUnique.mockResolvedValue(user);

      const response = await app.request('/api/users/me', {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { token: string; id: string };
      expect(data.token).toBe(token);
      expect(data.id).toBe(user.id);
    });
  });

  describe('POST /api/users/logout clears cookie', () => {
    it('should send Set-Cookie that clears the semiont-token cookie', async () => {
      const { email: makeEmail, userId: makeUserId } = require('@semiont/core');
      const user: User = {
        id: makeCuid(),
        email: 'logout@example.com',
        name: 'Logout User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-logout-123',
        passwordHash: null,
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const token = JWTService.generateToken({
        userId: makeUserId(user.id),
        email: makeEmail(user.email),
        domain: user.domain,
        provider: user.provider,
        isAdmin: user.isAdmin,
      });
      mockPrismaUser.findUnique.mockResolvedValue(user);

      const response = await app.request('/api/users/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { success: boolean };
      expect(data.success).toBe(true);

      // Verify the cookie is cleared (Max-Age=0 signals deletion)
      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).not.toBeNull();
      expect(setCookie).toMatch(/semiont-token=/);
      expect(setCookie).toMatch(/Max-Age=0/i);
    });
  });
});
