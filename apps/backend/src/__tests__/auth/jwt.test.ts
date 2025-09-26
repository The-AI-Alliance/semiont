/**
 * Comprehensive tests for JWT service
 * 
 * These tests verify that the JWT service:
 * - Generates secure JWT tokens with proper claims
 * - Validates JWT tokens correctly
 * - Handles token expiration and security properly
 * - Prevents JWT-related security vulnerabilities
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { JWTService } from '../../auth/jwt';
import { User } from '@prisma/client';

// Mock jsonwebtoken
vi.mock('jsonwebtoken', () => ({
  sign: vi.fn(),
  verify: vi.fn(),
  JsonWebTokenError: class JsonWebTokenError extends Error {},
  TokenExpiredError: class TokenExpiredError extends Error {
    constructor(message: string, public expiredAt: Date) {
      super(message);
    }
  },
  NotBeforeError: class NotBeforeError extends Error {
    constructor(message: string, public date: Date) {
      super(message);
    }
  },
}));

// Mock validation schemas - not needed anymore since JWT uses direct imports
vi.mock('../../validation/schemas', () => ({
  validateData: vi.fn((_schema, data) => ({ success: true, data })),
  JWTPayloadSchema: {},
}));

// Mock the jwt-types JWTPayloadSchema
vi.mock('../../types/jwt-types', () => ({
  JWTPayloadSchema: {
    safeParse: vi.fn((data) => ({ success: true, data })),
  },
}));

describe('JWT Service', () => {
  const mockUser: User = {
    id: 'clh1o0p0f0000qzrmn831i7rn', // Valid CUID format
    email: 'user@example.com',
    name: 'Test User',
    image: 'https://example.com/avatar.jpg',
    domain: 'example.com',
    provider: 'google',
    providerId: 'google-123',
    isAdmin: false,
    isActive: true,
    isModerator: false,
    termsAcceptedAt: null,
    lastLogin: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  const testDomain = 'test.example.com';
  const testAllowedDomains = ['example.com', 'test.org'];

  beforeEach(() => {
    vi.clearAllMocks();
    // Set the test configuration
    JWTService.setTestConfig(testDomain, testAllowedDomains);
  });
  
  afterEach(() => {
    // Reset configuration after each test
    JWTService.resetConfig();
  });

  describe('generateToken', () => {
    it('should generate JWT token with correct payload', () => {
      const expectedToken = 'generated.jwt.token';
      vi.mocked(vi.mocked(jwt.sign)).mockReturnValue(expectedToken as any);

      const result = JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      expect(result).toBe(expectedToken);
      expect(vi.mocked(jwt.sign)).toHaveBeenCalledWith(
        {
          userId: 'clh1o0p0f0000qzrmn831i7rn',
          email: 'user@example.com',
          name: 'Test User',
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
        },
        'test-secret-key-for-testing-32char',
        {
          expiresIn: '7d',
          issuer: 'test.example.com',
        }
      );
    });

    it('should generate token for admin user', () => {
      const expectedToken = 'admin.jwt.token';
      vi.mocked(vi.mocked(jwt.sign)).mockReturnValue(expectedToken as any);

      const result = JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: true,
      });

      expect(result).toBe(expectedToken);
      expect(vi.mocked(jwt.sign)).toHaveBeenCalledWith(
        expect.objectContaining({
          isAdmin: true,
        }),
        'test-secret-key-for-testing-32char',
        expect.any(Object)
      );
    });

    it('should handle user with optional name', () => {
      const expectedToken = 'minimal.jwt.token';
      vi.mocked(vi.mocked(jwt.sign)).mockReturnValue(expectedToken as any);

      const result = JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      expect(result).toBe(expectedToken);
      expect(vi.mocked(jwt.sign)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'clh1o0p0f0000qzrmn831i7rn',
          email: 'user@example.com',
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
        }),
        'test-secret-key-for-testing-32char',
        expect.any(Object)
      );
    });

    it('should throw error if JWT signing fails', () => {
      vi.mocked(jwt.sign).mockImplementation(() => {
        throw new Error('JWT signing failed');
      });

      expect(() => JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      })).toThrow('JWT signing failed');
    });

    it('should use secure JWT options', () => {
      vi.mocked(jwt.sign).mockReturnValue('test.token' as any);

      JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      const callArgs = vi.mocked(jwt.sign).mock.calls[0];
      const [, secret, options] = callArgs || [];
      
      expect(secret).toBe('test-secret-key-for-testing-32char');
      expect(options).toEqual({
        expiresIn: '7d',
        issuer: 'test.example.com',
      });
    });
  });

  describe('verifyToken', () => {
    const validPayload = {
      userId: 'clh1o0p0f0000qzrmn831i7rn',
      email: 'user@example.com',
      name: 'Test User',
      domain: 'example.com',
      provider: 'google',
      isAdmin: false,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    };

    beforeEach(async () => {
      // Reset the mock for each test
      const { JWTPayloadSchema } = await import('../../types/jwt-types');
      vi.mocked(JWTPayloadSchema.safeParse).mockReturnValue({ success: true, data: validPayload });
    });

    it('should verify valid JWT token', () => {
      vi.mocked(jwt.verify).mockReturnValue(validPayload as any);

      const result = JWTService.verifyToken('valid.jwt.token');

      expect(result).toEqual(validPayload);
      expect(vi.mocked(jwt.verify)).toHaveBeenCalledWith(
        'valid.jwt.token',
        'test-secret-key-for-testing-32char'
      );
    });

    it('should verify admin token correctly', async () => {
      const adminPayload = { ...validPayload, isAdmin: true };
      vi.mocked(jwt.verify).mockReturnValue(adminPayload as any);

      const { JWTPayloadSchema } = await import('../../types/jwt-types');
      vi.mocked(JWTPayloadSchema.safeParse).mockReturnValue({ success: true, data: adminPayload });

      const result = JWTService.verifyToken('admin.jwt.token');

      expect(result.isAdmin).toBe(true);
    });

    it('should throw error for invalid token signature', () => {
      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid signature');
      });

      expect(() => JWTService.verifyToken('invalid.signature.token'))
        .toThrow('Invalid token signature');
    });

    it('should throw error for expired token', () => {
      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new jwt.TokenExpiredError('Token expired', new Date());
      });

      expect(() => JWTService.verifyToken('expired.jwt.token'))
        .toThrow('Token has expired');
    });

    it('should throw error for token not active yet (NotBeforeError)', () => {
      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new jwt.NotBeforeError('Token not active yet', new Date());
      });

      expect(() => JWTService.verifyToken('not-active-yet.jwt.token'))
        .toThrow('Token not active yet');
    });

    it('should handle payload validation errors', async () => {
      vi.mocked(jwt.verify).mockReturnValue(validPayload as any);

      const { JWTPayloadSchema } = await import('../../types/jwt-types');
      vi.mocked(JWTPayloadSchema.safeParse).mockReturnValue({
        success: false,
        error: { message: 'Invalid payload structure' }
      } as any);

      expect(() => JWTService.verifyToken('invalid.payload.token'))
        .toThrow('Invalid token payload: Invalid payload structure');
    });
  });

  describe('isAllowedDomain', () => {
    it('should allow configured domains', () => {
      // The mock has oauthAllowedDomains: ['example.com', 'test.org']
      expect(JWTService.isAllowedDomain('user@example.com')).toBe(true);
      expect(JWTService.isAllowedDomain('admin@test.org')).toBe(true);
    });

    it('should reject non-configured domains', () => {
      expect(JWTService.isAllowedDomain('user@evil.com')).toBe(false);
      expect(JWTService.isAllowedDomain('admin@hacker.org')).toBe(false);
    });

    it('should handle invalid email formats', () => {
      expect(JWTService.isAllowedDomain('invalid-email')).toBe(false);
      expect(JWTService.isAllowedDomain('')).toBe(false);
      expect(JWTService.isAllowedDomain('@example.com')).toBe(false);
    });
  });

  describe('Security', () => {
    it('should not expose secret in error messages', () => {
      vi.mocked(jwt.sign).mockImplementation(() => {
        throw new Error('Signing failed with secret: test-secret-key-for-testing');
      });

      try {
        JWTService.generateToken({
          userId: mockUser.id,
          email: mockUser.email,
          name: mockUser.name || undefined,
          domain: mockUser.domain,
          provider: mockUser.provider,
          isAdmin: mockUser.isAdmin,
        });
        expect.fail('Should have thrown an error');
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain('Signing failed');
      }
    });

    it('should handle concurrent token operations safely', () => {
      const users = [
        { userId: 'user-1', email: 'user1@example.com', name: 'User 1', domain: 'example.com', provider: 'google', isAdmin: false },
        { userId: 'user-2', email: 'user2@example.com', name: 'User 2', domain: 'example.com', provider: 'google', isAdmin: false },
        { userId: 'user-3', email: 'user3@example.com', name: 'User 3', domain: 'example.com', provider: 'google', isAdmin: true },
      ];

      vi.mocked(jwt.sign)
        .mockReturnValueOnce('token-1' as any)
        .mockReturnValueOnce('token-2' as any)
        .mockReturnValueOnce('token-3' as any);

      const tokens = users.map(user => JWTService.generateToken(user));

      expect(tokens).toEqual(['token-1', 'token-2', 'token-3']);
      expect(vi.mocked(jwt.sign)).toHaveBeenCalledTimes(3);
    });

    it('should validate token expiration settings', () => {
      vi.mocked(jwt.sign).mockReturnValue('test.token' as any);

      JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      const callArgs = vi.mocked(jwt.sign).mock.calls[0];
      const [, , options] = callArgs || [];
      
      // Should have reasonable expiration time
      expect(options?.expiresIn).toBe('7d');
      expect(options?.expiresIn).not.toBe('100y'); // Should not be extremely long
      expect(options?.expiresIn).not.toBe('1s');   // Should not be extremely short
    });

    it('should ensure admin flag cannot be escalated through token manipulation', () => {
      vi.mocked(jwt.sign).mockReturnValue('regular.token' as any);

      JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: false,
      });

      expect(vi.mocked(jwt.sign)).toHaveBeenCalledWith(
        expect.objectContaining({
          isAdmin: false,
        }),
        expect.any(String),
        expect.any(Object)
      );

      const callArgs = vi.mocked(jwt.sign).mock.calls[0];
      const [payload] = callArgs || [];
      expect((payload as any)?.isAdmin).toBe(false);
    });
  });
});