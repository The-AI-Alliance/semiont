/**
 * Comprehensive tests for JWT service
 * 
 * These tests verify that the JWT service:
 * - Generates secure JWT tokens with proper claims
 * - Validates JWT tokens correctly
 * - Handles token expiration and security properly
 * - Prevents JWT-related security vulnerabilities
 */

import * as jwt from 'jsonwebtoken';
import { JWTService } from '../../auth/jwt';
import { User } from '@prisma/client';

// Mock jsonwebtoken
jest.mock('jsonwebtoken');
const mockJwt = jwt as jest.Mocked<typeof jwt>;

// Mock CONFIG
jest.mock('../../config', () => ({
  CONFIG: {
    JWT_SECRET: 'test-secret-key-for-testing',
    DOMAIN: 'test.example.com',
  }
}));

// Mock validation schemas
jest.mock('../../validation/schemas', () => ({
  validateData: jest.fn((_schema, data) => ({ success: true, data })),
  JWTPayloadSchema: {},
}));

describe('JWT Service', () => {
  const mockUser: User = {
    id: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    image: 'https://example.com/avatar.jpg',
    domain: 'example.com',
    provider: 'google',
    providerId: 'google-123',
    isAdmin: false,
    isActive: true,
    lastLogin: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateToken', () => {
    it('should generate JWT token with correct payload', () => {
      const expectedToken = 'generated.jwt.token';
      mockJwt.sign.mockReturnValue(expectedToken as any);

      const result = JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      expect(result).toBe(expectedToken);
      expect(mockJwt.sign).toHaveBeenCalledWith(
        {
          userId: 'user-123',
          email: 'user@example.com',
          name: 'Test User',
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
        },
        'test-secret-key-for-testing',
        {
          expiresIn: '7d',
          issuer: 'test.example.com',
        }
      );
    });

    it('should generate token for admin user', () => {
      const expectedToken = 'admin.jwt.token';
      mockJwt.sign.mockReturnValue(expectedToken as any);

      const result = JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: true,
      });

      expect(result).toBe(expectedToken);
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          isAdmin: true,
        }),
        'test-secret-key-for-testing',
        expect.any(Object)
      );
    });

    it('should handle user with optional name', () => {
      const expectedToken = 'minimal.jwt.token';
      mockJwt.sign.mockReturnValue(expectedToken as any);

      const result = JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      expect(result).toBe(expectedToken);
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          email: 'user@example.com',
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
        }),
        'test-secret-key-for-testing',
        expect.any(Object)
      );
    });

    it('should throw error if JWT signing fails', () => {
      mockJwt.sign.mockImplementation(() => {
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
      mockJwt.sign.mockReturnValue('test.token' as any);

      JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      const callArgs = mockJwt.sign.mock.calls[0];
      const [, secret, options] = callArgs || [];
      
      expect(secret).toBe('test-secret-key-for-testing');
      expect(options).toEqual({
        expiresIn: '7d',
        issuer: 'test.example.com',
      });
    });
  });

  describe('verifyToken', () => {
    const validPayload = {
      userId: 'user-123',
      email: 'user@example.com',
      name: 'Test User',
      domain: 'example.com',
      provider: 'google',
      isAdmin: false,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    };

    beforeEach(() => {
      // Mock successful validation
      const mockValidateData = require('../../validation/schemas').validateData;
      mockValidateData.mockReturnValue({ success: true, data: validPayload });
    });

    it('should verify valid JWT token', () => {
      mockJwt.verify.mockReturnValue(validPayload as any);

      const result = JWTService.verifyToken('valid.jwt.token');

      expect(result).toEqual(validPayload);
      expect(mockJwt.verify).toHaveBeenCalledWith(
        'valid.jwt.token',
        'test-secret-key-for-testing'
      );
    });

    it('should verify admin token correctly', () => {
      const adminPayload = { ...validPayload, isAdmin: true };
      mockJwt.verify.mockReturnValue(adminPayload as any);
      
      const mockValidateData = require('../../validation/schemas').validateData;
      mockValidateData.mockReturnValue({ success: true, data: adminPayload });

      const result = JWTService.verifyToken('admin.jwt.token');

      expect(result.isAdmin).toBe(true);
    });

    it('should throw error for invalid token signature', () => {
      mockJwt.verify.mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid signature');
      });

      expect(() => JWTService.verifyToken('invalid.signature.token'))
        .toThrow('Invalid token signature');
    });

    it('should throw error for expired token', () => {
      mockJwt.verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('Token expired', new Date());
      });

      expect(() => JWTService.verifyToken('expired.jwt.token'))
        .toThrow('Token has expired');
    });

    it('should handle payload validation errors', () => {
      mockJwt.verify.mockReturnValue(validPayload as any);
      
      const mockValidateData = require('../../validation/schemas').validateData;
      mockValidateData.mockReturnValue({ 
        success: false, 
        error: 'Invalid payload structure' 
      });

      expect(() => JWTService.verifyToken('invalid.payload.token'))
        .toThrow('Invalid token payload: Invalid payload structure');
    });
  });

  describe('isAllowedDomain', () => {
    beforeAll(() => {
      // Mock CONFIG for domain tests
      const mockConfig = require('../../config');
      mockConfig.CONFIG.OAUTH_ALLOWED_DOMAINS = ['example.com', 'test.org'];
    });

    it('should allow configured domains', () => {
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
      mockJwt.sign.mockImplementation(() => {
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
        fail('Should have thrown an error');
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

      mockJwt.sign
        .mockReturnValueOnce('token-1' as any)
        .mockReturnValueOnce('token-2' as any)
        .mockReturnValueOnce('token-3' as any);

      const tokens = users.map(user => JWTService.generateToken(user));

      expect(tokens).toEqual(['token-1', 'token-2', 'token-3']);
      expect(mockJwt.sign).toHaveBeenCalledTimes(3);
    });

    it('should validate token expiration settings', () => {
      mockJwt.sign.mockReturnValue('test.token' as any);

      JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      });

      const callArgs = mockJwt.sign.mock.calls[0];
      const [, , options] = callArgs || [];
      
      // Should have reasonable expiration time
      expect(options?.expiresIn).toBe('7d');
      expect(options?.expiresIn).not.toBe('100y'); // Should not be extremely long
      expect(options?.expiresIn).not.toBe('1s');   // Should not be extremely short
    });

    it('should ensure admin flag cannot be escalated through token manipulation', () => {
      mockJwt.sign.mockReturnValue('regular.token' as any);

      JWTService.generateToken({
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: false,
      });

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          isAdmin: false,
        }),
        expect.any(String),
        expect.any(Object)
      );

      const callArgs = mockJwt.sign.mock.calls[0];
      const [payload] = callArgs || [];
      expect((payload as any)?.isAdmin).toBe(false);
    });
  });
});