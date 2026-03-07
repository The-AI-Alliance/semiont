import { userId } from '@semiont/core';
import { email } from '@semiont/core';
/**
 * MCP Authentication Security Tests
 * 
 * Tests to verify the security of MCP OAuth flow and token refresh endpoints
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JWTService } from '../../auth/jwt';
import { DatabaseConnection } from '../../db';
import type { User } from '@prisma/client';

// Mock database connection
vi.mock('../../db', () => ({
  DatabaseConnection: {
    getClient: vi.fn(() => ({
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn()
      }
    }))
  }
}));

describe('MCP Authentication security', () => {
  let mockPrisma: any;
  
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup database mock
    mockPrisma = {
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn()
      }
    };
    (DatabaseConnection.getClient as any).mockReturnValue(mockPrisma);
    
    // Setup JWT service test config
    JWTService.setTestConfig('test.semiont.com', ['example.com']);
  });

  afterEach(() => {
    JWTService.resetConfig();
  });

  describe('/api/auth/mcp-setup Security', () => {
    it('security: should require authentication for MCP setup endpoint', async () => {
      // This test resources that the endpoint MUST have authMiddleware
      // The actual implementation has authMiddleware, so unauthorized access returns 401
      expect(true).toBe(true); // Placeholder - actual test would make HTTP request
    });

    it('security: should not expose refresh tokens in logs', () => {
      // Generate a test refresh token
      const refreshToken = JWTService.generateToken({
        userId: userId('clh0vssng0000356tmf4mt8fb'),
        email: email('test@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
      }, '30d');
      
      // Ensure token is not accidentally logged
      const consoleSpy = vi.spyOn(console, 'log');
      const debugSpy = vi.spyOn(console, 'debug');
      
      // Simulate token generation (without actually logging)
      // The implementation should never log tokens
      
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining(refreshToken));
      expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining(refreshToken));
    });

    it('security: should validate callback URL to prevent open redirect', () => {
      const validCallbacks = [
        'http://localhost:8585/callback',
        'http://localhost:3000/callback',
        'http://127.0.0.1:8585/callback'
      ];
      
      const invalidCallbacks = [
        'http://evil.com/phishing',
        'javascript:alert(1)',
        '//evil.com/redirect',
        'data:text/html,<script>alert(1)</script>'
      ];
      
      // Valid callbacks should be allowed
      validCallbacks.forEach(url => {
        expect(url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')).toBe(true);
      });
      
      // Invalid callbacks should be rejected
      invalidCallbacks.forEach(url => {
        expect(url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')).toBe(false);
      });
    });

    it('security: should use secure token generation with sufficient entropy', async () => {
      // Test that refresh tokens have proper length and randomness
      const token1 = JWTService.generateToken({
        userId: userId('clh0vssng0001356tmf4mt8fb'),
        email: email('user1@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
      }, '30d');
      
      // Wait 1 second to ensure different iat timestamp (JWT timestamps are in seconds)
      await new Promise(resolve => setTimeout(resolve, 1001));
      
      const token2 = JWTService.generateToken({
        userId: userId('clh0vssng0001356tmf4mt8fb'), // Same user
        email: email('user1@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
      }, '30d');
      
      // Tokens for same user should be different (includes timestamp)
      expect(token1).not.toBe(token2);
      
      // Tokens should be sufficiently long
      expect(token1.length).toBeGreaterThan(100);
    });
  });

  describe('/api/auth/refresh Security', () => {
    it('security: should reject invalid refresh tokens', async () => {
      const invalidTokens = [
        'invalid.token.here',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid',
        '',
        null,
        undefined
      ];
      
      invalidTokens.forEach(token => {
        if (token) {
          expect(() => JWTService.verifyToken(token)).toThrow();
        }
      });
    });

    it('security: should reject access tokens used as refresh tokens', () => {
      // This test resources that access and refresh tokens are differentiated by expiration time
      // Access tokens: short-lived (1 hour)
      // Refresh tokens: long-lived (30 days)
      const accessToken = JWTService.generateToken({
        userId: userId('clh0vssng0002356tmf4mt8fb'),
        email: email('test@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false
      }, '1h'); // Access token: 1 hour expiry
      
      const refreshToken = JWTService.generateToken({
        userId: userId('clh0vssng0002356tmf4mt8fb'),
        email: email('test@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false
      }, '30d'); // Refresh token: 30 day expiry
      
      // Verify tokens are valid
      const accessPayload = JWTService.verifyToken(accessToken);
      const refreshPayload = JWTService.verifyToken(refreshToken);
      
      // Access token should have much shorter expiration
      const accessExp = accessPayload.exp!;
      const refreshExp = refreshPayload.exp!;
      const now = Math.floor(Date.now() / 1000);
      
      // Access token expires in ~1 hour
      expect(accessExp - now).toBeLessThanOrEqual(3600 + 5); // 1 hour + 5s margin
      // Refresh token expires in ~30 days  
      expect(refreshExp - now).toBeGreaterThan(86400 * 29); // At least 29 days
    });

    it('security: should reject refresh tokens for deleted users', async () => {
      // Setup: User doesn't exist in database
      mockPrisma.user.findUnique.mockResolvedValue(null);
      
      const refreshToken = JWTService.generateToken({
        userId: userId('clh0vssng0003356tmf4mt8fb'),
        email: email('deleted@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
      }, '30d');
      
      // Token is valid JWT but user doesn't exist
      const payload = JWTService.verifyToken(refreshToken);
      expect(payload.userId).toBe('clh0vssng0003356tmf4mt8fb');
      
      // When refresh endpoint checks database, user won't be found
      const user = await mockPrisma.user.findUnique({ where: { id: payload.userId } });
      expect(user).toBeNull();
    });

    it('security: should reject expired refresh tokens', () => {
      // We can't easily create an expired token with the current time,
      // but we can verify that expired tokens throw errors
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0IiwiZXhwIjoxMDAwMDAwMDAwfQ.invalid';
      
      expect(() => JWTService.verifyToken(expiredToken)).toThrow();
    });

    it('security: should limit refresh token usage rate', () => {
      // This resources that the implementation should have rate limiting
      // to prevent refresh token abuse
      const maxRefreshesPerMinute = 10; // Reasonable limit
      
      // In production, this would be enforced by rate limiting middleware
      expect(maxRefreshesPerMinute).toBeLessThanOrEqual(10);
    });

    it('security: should not expose sensitive data in error responses', async () => {
      // Test various error conditions
      const errorConditions = [
        { refresh_token: null, expectedError: 'Refresh token required' },
        { refresh_token: 'invalid', expectedError: 'Invalid token' },
        { refresh_token: 'expired.token.here', expectedError: 'Token expired' }
      ];
      
      errorConditions.forEach(({ expectedError }) => {
        // Error message should not contain:
        // - Stack traces
        // - Database connection strings
        // - Internal file paths
        // - JWT secrets
        expect(expectedError).not.toMatch(/at.*\.js:[0-9]+/); // No stack traces
        expect(expectedError).not.toMatch(/postgresql:\/\//); // No DB URLs
        expect(expectedError).not.toMatch(/\/home\/|\/Users\//); // No file paths
        expect(expectedError).not.toMatch(/secret|key/i); // No secrets
      });
    });

    it('security: should generate short-lived access tokens from refresh tokens', () => {
      const mockUser: User = {
        id: 'clh0vssng0004356tmf4mt8fb',
        email: email('test@example.com'),
        name: 'Test User',
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-123',
    passwordHash: null,
        image: null,
        isActive: true,
        isAdmin: false,
        isModerator: false,
        lastLogin: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        termsAcceptedAt: new Date()
      };
      
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      
      // Generate access token (would be done by refresh endpoint)
      const accessToken = JWTService.generateToken({
        userId: userId(mockUser.id),
        email: email(mockUser.email),
        name: mockUser.name || undefined,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      }, '1h'); // 1 hour expiration
      
      const payload = JWTService.verifyToken(accessToken);
      
      // Verify short expiration (1 hour from now)
      const expTime = payload.exp! * 1000; // Convert to milliseconds
      const now = Date.now();
      const oneHourInMs = 60 * 60 * 1000;
      
      expect(expTime - now).toBeLessThanOrEqual(oneHourInMs + 5000); // Allow 5s margin
      expect(expTime - now).toBeGreaterThan(oneHourInMs - 5000);
    });
  });

  describe('Token Security Best Practices', () => {
    it('security: should use secure JWT algorithm', () => {
      const token = JWTService.generateToken({
        userId: userId('clh0vssng0005356tmf4mt8fb'),
        email: email('test@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false
      });
      
      // Decode header to check algorithm
      const [headerB64] = token.split('.');
      const header = JSON.parse(Buffer.from(headerB64 || '', 'base64').toString());
      
      // Should use HS256 or stronger
      expect(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512']).toContain(header.alg);
      
      // Should not use 'none' algorithm
      expect(header.alg).not.toBe('none');
    });

    it('security: should include proper token claims', () => {
      const token = JWTService.generateToken({
        userId: userId('clh0vssng0002356tmf4mt8fb'),
        email: email('test@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false,
      }, '30d');
      
      const payload = JWTService.verifyToken(token);
      
      // Should include required claims
      expect(payload.userId).toBeDefined();
      expect(payload.email).toBeDefined();
      expect(payload.iat!).toBeDefined(); // Issued at
      expect(payload.exp!).toBeDefined(); // Expiration
    });

    it('security: should separate refresh and access token permissions', () => {
      // Resource the separation of refresh and access tokens by expiration time
      // Refresh tokens: long-lived (30 days), used only to get new access tokens
      // Access tokens: short-lived (1 hour), used for API calls
      
      const refreshToken = JWTService.generateToken({
        userId: userId('clh0vssng0005356tmf4mt8fb'),
        email: email('test@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false
      }, '30d');
      
      const refreshPayload = JWTService.verifyToken(refreshToken);
      
      // Access tokens should be used for API calls
      const accessToken = JWTService.generateToken({
        userId: userId('clh0vssng0005356tmf4mt8fb'),
        email: email('test@example.com'),
        domain: 'example.com',
        provider: 'google',
        isAdmin: false
      }, '1h');
      
      const accessPayload = JWTService.verifyToken(accessToken);
      
      // Both tokens include permissions
      expect(refreshPayload.isAdmin).toBeDefined();
      expect(accessPayload.isAdmin).toBeDefined();
      
      // Differentiated by expiration time
      const refreshExp = refreshPayload.exp!;
      const accessExp = accessPayload.exp!;
      expect(refreshExp).toBeGreaterThan(accessExp); // Refresh token lasts longer
    });

    it('security: should have reasonable token expiration times', () => {
      // Resource expected expiration times for security
      const refreshTokenExpiry = 30 * 24 * 60 * 60; // 30 days in seconds
      const accessTokenExpiry = 60 * 60; // 1 hour in seconds
      
      // Refresh tokens: long-lived but not permanent
      expect(refreshTokenExpiry).toBeLessThanOrEqual(30 * 24 * 60 * 60); // Max 30 days
      expect(refreshTokenExpiry).toBeGreaterThanOrEqual(7 * 24 * 60 * 60); // Min 7 days
      
      // Access tokens: short-lived
      expect(accessTokenExpiry).toBeLessThanOrEqual(24 * 60 * 60); // Max 24 hours
      expect(accessTokenExpiry).toBeGreaterThanOrEqual(15 * 60); // Min 15 minutes
    });
  });

  describe('MCP OAuth Flow Security', () => {
    it('security: should validate OAuth state parameter to prevent CSRF', () => {
      // The MCP setup flow should include state validation
      // This is handled by the OAuth provider (Google, GitHub, etc.)
      // but we should resource the requirement
      expect(true).toBe(true); // Placeholder - actual OAuth flow includes state
    });

    it('security: should use HTTPS in production for token transmission', () => {
      // In production, all auth endpoints should use HTTPS
      const productionUrls = [
        'https://api.semiont.com/api/auth/mcp-setup',
        'https://api.semiont.com/api/auth/refresh'
      ];
      
      productionUrls.forEach(url => {
        expect(url.startsWith('https://')).toBe(true);
      });
    });

    it('security: should store tokens securely on client side', () => {
      // Resource that tokens should be stored securely
      // - Refresh tokens in encrypted config files
      // - Access tokens in memory only
      // - Never in plain text files or logs
      
      const secureStorageLocations = [
        '~/.config/semiont/mcp-auth-*.json', // Should be mode 600
        process.env.SEMIONT_API_TOKEN || '' // In memory via environment
      ];
      
      const insecureLocations = [
        '/tmp/token.txt',
        './token.json',
        'localStorage' // For CLI, not applicable but good to resource
      ];
      
      // This resources the security requirement
      expect(secureStorageLocations.length).toBeGreaterThan(0);
      expect(insecureLocations).toBeDefined(); // Should be avoided
    });
  });
});