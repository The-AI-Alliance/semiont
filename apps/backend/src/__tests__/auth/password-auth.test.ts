/**
 * Tests for password authentication
 * Following TDD approach - tests written before implementation
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// Mock config-loader to avoid needing SEMIONT_ROOT
vi.mock('../../config-loader', () => ({
  findProjectRoot: vi.fn(() => '/tmp/test-project'),
  loadEnvironmentConfig: vi.fn(() => ({
    site: { domain: 'test.local', oauthAllowedDomains: ['test.local'] },
    env: { NODE_ENV: 'test' },
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
      },
      filesystem: {
        platform: { type: 'posix' },
        path: `/tmp/semiont-test-${process.pid}-${Date.now()}`
      }
    },
    app: {}
  })),
}));

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

import { app } from '../../index';
import { DatabaseConnection } from '../../db';
import { JWTService } from '../../auth/jwt';
import { User } from '@prisma/client';
import { faker } from '@faker-js/faker';
import * as bcrypt from 'bcrypt';
import type { components } from '@semiont/core';

type AuthResponse = components["schemas"]["AuthResponse"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const prisma = DatabaseConnection.getClient();
const mockPrismaUser = vi.mocked(prisma.user);

describe('POST /api/tokens/password', () => {
  const testEmail = 'password-test@example.com';
  const testPassword = 'testpassword123';
  let passwordHash: string;

  beforeAll(() => {
    // Initialize JWTService with test config
    JWTService.initialize({
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local'] },
      services: {
        backend: {
          platform: { type: 'posix' },
          corsOrigin: 'http://localhost:3000',
          publicURL: 'http://localhost:4000',
          port: 4000
        },
        frontend: {
          platform: { type: 'posix' },
          publicURL: 'http://localhost:3000',
          port: 3000,
          siteName: 'Test Site'
        }
      },
      app: {}
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create password hash for test user
    passwordHash = await bcrypt.hash(testPassword, 12);
  });

  describe('successful authentication', () => {
    it('should return 200 with token for valid credentials', async () => {
      const mockUser: User = {
        id: faker.string.uuid(),
        email: testEmail,
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: testEmail,
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
      mockPrismaUser.update.mockResolvedValue({
        ...mockUser,
        lastLogin: new Date()
      });

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json() as AuthResponse;
      expect(data.success).toBe(true);
      expect(data.user.email).toBe(testEmail);
      expect(data.token).toBeDefined();
      expect(data.isNewUser).toBe(false);
    });

    it('should update lastLogin timestamp on success', async () => {
      const mockUser: User = {
        id: faker.string.uuid(),
        email: testEmail,
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: testEmail,
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
      mockPrismaUser.update.mockResolvedValue({
        ...mockUser,
        lastLogin: new Date()
      });

      await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword
        }),
      });

      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: expect.objectContaining({
          lastLogin: expect.any(Date)
        })
      });
    });

    it('should return JWT token in response', async () => {
      const mockUser: User = {
        id: faker.string.uuid(),
        email: testEmail,
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: testEmail,
        passwordHash,
        isAdmin: true,
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
          email: testEmail,
          password: testPassword
        }),
      });

      const data = await response.json() as AuthResponse;

      // JWT should be a string with three parts separated by dots
      expect(typeof data.token).toBe('string');
      expect(data.token.split('.')).toHaveLength(3);
    });
  });

  describe('invalid credentials', () => {
    it('should return 401 for non-existent email', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: testPassword
        }),
      });

      expect(response.status).toBe(401);

      const data = await response.json() as ErrorResponse;
      expect(data.error).toContain('Invalid credentials');
    });

    it('should return 401 for wrong password', async () => {
      const mockUser: User = {
        id: faker.string.uuid(),
        email: testEmail,
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: testEmail,
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

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: 'wrongpassword'
        }),
      });

      expect(response.status).toBe(401);

      const data = await response.json() as ErrorResponse;
      expect(data.error).toContain('Invalid credentials');
    });

    it('should not reveal whether email exists in error message', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: testPassword
        }),
      });

      const data = await response.json() as ErrorResponse;

      // Should not say "email not found" or similar
      expect(data.error.toLowerCase()).not.toContain('not found');
      expect(data.error.toLowerCase()).not.toContain('does not exist');
      expect(data.error).toBe('Invalid credentials');
    });
  });

  describe('OAuth user rejection', () => {
    it('should return 400 when OAuth user tries password auth', async () => {
      const mockOAuthUser: User = {
        id: faker.string.uuid(),
        email: testEmail,
        name: 'OAuth User',
        image: 'https://example.com/photo.jpg',
        domain: 'example.com',
        provider: 'google', // OAuth provider, not 'password'
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

      mockPrismaUser.findUnique.mockResolvedValue(mockOAuthUser);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json() as ErrorResponse;
      expect(data.error).toContain('OAuth');
    });
  });

  describe('inactive user rejection', () => {
    it('should return 403 for inactive user', async () => {
      const mockInactiveUser: User = {
        id: faker.string.uuid(),
        email: testEmail,
        name: 'Inactive User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: testEmail,
        passwordHash,
        isAdmin: false,
        isActive: false, // Inactive
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findUnique.mockResolvedValue(mockInactiveUser);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword
        }),
      });

      expect(response.status).toBe(403);

      const data = await response.json() as ErrorResponse;
      expect(data.error).toContain('not active');
    });
  });

  describe('missing passwordHash', () => {
    it('should return 400 when user has no passwordHash', async () => {
      const mockUserNoHash: User = {
        id: faker.string.uuid(),
        email: testEmail,
        name: 'No Hash User',
        image: null,
        domain: 'example.com',
        provider: 'password',
        providerId: testEmail,
        passwordHash: null, // No password hash set
        isAdmin: false,
        isActive: true,
        isModerator: false,
        termsAcceptedAt: null,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaUser.findUnique.mockResolvedValue(mockUserNoHash);

      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword
        }),
      });

      expect(response.status).toBe(400);

      const data = await response.json() as ErrorResponse;
      expect(data.error).toContain('Password not set');
    });
  });

  describe('request validation', () => {
    it('should return 400 for missing email', async () => {
      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password: testPassword
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing password', async () => {
      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: testEmail
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid email format', async () => {
      const response = await app.request('/api/tokens/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'not-an-email',
          password: testPassword
        }),
      });

      expect(response.status).toBe(400);
    });
  });
});
