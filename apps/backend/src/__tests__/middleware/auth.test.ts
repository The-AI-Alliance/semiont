/**
 * Comprehensive tests for authentication middleware
 * 
 * These tests verify that the auth middleware properly:
 * - Validates Authorization headers and JWT tokens
 * - Handles authentication errors securely
 * - Sets user context correctly
 * - Prevents security vulnerabilities
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Context } from 'hono';
import { authMiddleware, optionalAuthMiddleware } from '../../middleware/auth';
import { OAuthService } from '../../auth/oauth';
import { User } from '@prisma/client';

// Mock OAuthService
vi.mock('../../auth/oauth', () => ({
  OAuthService: {
    getUserFromToken: vi.fn(),
  }
}));

const mockOAuthService = OAuthService as vi.Mocked<typeof OAuthService>;

// Helper to create mock Hono context
function createMockContext(headers: Record<string, string> = {}): Context {
  const mockJson = vi.fn().mockReturnValue(new Response());
  const mockSet = vi.fn();
  const mockGet = vi.fn();

  const context = {
    req: {
      header: vi.fn((name: string) => headers[name]),
    },
    json: mockJson,
    set: mockSet,
    get: mockGet,
  } as any;

  return context;
}

const mockNext = vi.fn();

describe('Auth Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authMiddleware', () => {
    describe('Header Validation', () => {
      it('should return 401 for missing Authorization header', async () => {
        const context = createMockContext();
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockOAuthService.getUserFromToken).not.toHaveBeenCalled();
      });

      it('should return 401 for non-Bearer Authorization header', async () => {
        const context = createMockContext({ 'Authorization': 'Basic dXNlcjpwYXNz' });
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should return 401 for Bearer header without token', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer' });
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should return 401 for Bearer header with only spaces', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer   ' });
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should handle case-sensitive Bearer scheme', async () => {
        const testCases = [
          'bearer token123',  // lowercase
          'BEARER token123',  // uppercase
          'BeArEr token123'   // mixed case
        ];

        for (const authHeader of testCases) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': authHeader });
          
          await authMiddleware(context, mockNext);
          
          expect(context.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
          expect(mockNext).not.toHaveBeenCalled();
        }
      });
    });

    describe('Token Validation', () => {
      it('should return 401 for invalid JWT token', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer invalid-token' });
        mockOAuthService.getUserFromToken.mockRejectedValue(new Error('Invalid token'));
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Invalid token' }, 401);
        expect(mockNext).not.toHaveBeenCalled();
        expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith('invalid-token');
      });

      it('should return 401 for expired JWT token', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer expired-token' });
        mockOAuthService.getUserFromToken.mockRejectedValue(new Error('Token expired'));
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Invalid token' }, 401);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should return 401 for malformed JWT token', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer not.a.valid.jwt' });
        mockOAuthService.getUserFromToken.mockRejectedValue(new Error('Malformed JWT'));
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Invalid token' }, 401);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should extract token correctly from Authorization header', async () => {
        const testTokens = [
          'simple-token',
          'very.long.jwt.token.with.many.parts.and.signatures',
          'token-with-special-chars!@#$%^&*()',
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
        ];

        for (const token of testTokens) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': `Bearer ${token}` });
          mockOAuthService.getUserFromToken.mockRejectedValue(new Error('Test error'));
          
          await authMiddleware(context, mockNext);
          
          expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith(token);
        }
      });
    });

    describe('Successful Authentication', () => {
      const mockUser: User = {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-123',
        isAdmin: false,
        isActive: true,
        lastLogin: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      it('should set user context and call next for valid token', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer valid-token' });
        mockOAuthService.getUserFromToken.mockResolvedValue(mockUser);
        
        await authMiddleware(context, mockNext);
        
        expect(context.set).toHaveBeenCalledWith('user', mockUser);
        expect(mockNext).toHaveBeenCalled();
        expect(context.json).not.toHaveBeenCalled();
        expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith('valid-token');
      });

      it('should handle admin users correctly', async () => {
        const adminUser = { ...mockUser, isAdmin: true };
        const context = createMockContext({ 'Authorization': 'Bearer admin-token' });
        mockOAuthService.getUserFromToken.mockResolvedValue(adminUser);
        
        await authMiddleware(context, mockNext);
        
        expect(context.set).toHaveBeenCalledWith('user', adminUser);
        expect(mockNext).toHaveBeenCalled();
        expect(context.json).not.toHaveBeenCalled();
      });

      it('should handle users with minimal data', async () => {
        const minimalUser = {
          ...mockUser,
          name: null,
          image: null,
          lastLogin: null,
        };
        const context = createMockContext({ 'Authorization': 'Bearer minimal-token' });
        mockOAuthService.getUserFromToken.mockResolvedValue(minimalUser);
        
        await authMiddleware(context, mockNext);
        
        expect(context.set).toHaveBeenCalledWith('user', minimalUser);
        expect(mockNext).toHaveBeenCalled();
      });
    });

    describe('Error Handling Security', () => {
      it('should not leak sensitive information in error responses', async () => {
        const sensitiveErrors = [
          new Error('Database connection failed: postgresql://user:pass@host:5432/db'),
          new Error('JWT verification failed with secret: super-secret-key-123'),
          new Error('Token decode error: invalid signature using key sk_test_123'),
          new Error('User lookup failed: email admin@company.com not found'),
          new Error('Authentication failed at /src/auth/jwt.ts:45'),
        ];

        for (const error of sensitiveErrors) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': 'Bearer token' });
          mockOAuthService.getUserFromToken.mockRejectedValue(error);
          
          await authMiddleware(context, mockNext);
          
          // Should always return generic error message
          expect(context.json).toHaveBeenCalledWith({ error: 'Invalid token' }, 401);
          
          // Verify no sensitive information is exposed  
          const jsonCall = (context.json as any).mock?.calls?.[0];
          const errorResponse = jsonCall?.[0];
          expect(JSON.stringify(errorResponse)).not.toContain('postgresql://');
          expect(JSON.stringify(errorResponse)).not.toContain('super-secret-key');
          expect(JSON.stringify(errorResponse)).not.toContain('sk_test_');
          expect(JSON.stringify(errorResponse)).not.toContain('admin@company.com');
          expect(JSON.stringify(errorResponse)).not.toContain('/src/auth/');
        }
      });

      it('should handle network errors gracefully', async () => {
        const networkErrors = [
          new Error('ECONNREFUSED'),
          new Error('ETIMEDOUT'),
          new Error('Network unreachable'),
          new Error('DNS resolution failed'),
        ];

        for (const error of networkErrors) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': 'Bearer token' });
          mockOAuthService.getUserFromToken.mockRejectedValue(error);
          
          await authMiddleware(context, mockNext);
          
          expect(context.json).toHaveBeenCalledWith({ error: 'Invalid token' }, 401);
          expect(mockNext).not.toHaveBeenCalled();
        }
      });
    });

    describe('Security Edge Cases', () => {
      it('should handle extremely long tokens safely', async () => {
        const longToken = 'a'.repeat(10000);
        const context = createMockContext({ 'Authorization': `Bearer ${longToken}` });
        mockOAuthService.getUserFromToken.mockRejectedValue(new Error('Token too long'));
        
        await authMiddleware(context, mockNext);
        
        expect(context.json).toHaveBeenCalledWith({ error: 'Invalid token' }, 401);
        expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith(longToken);
      });

      it('should handle tokens with newlines and special characters', async () => {
        const specialTokens = [
          'token\\nwith\\nnewlines',
          'token\\rwith\\rcarriagereturn',
          'token\\twith\\ttabs',
          'token with spaces',
          'token"with"quotes',
          'token\'with\'singlequotes',
        ];

        for (const token of specialTokens) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': `Bearer ${token}` });
          mockOAuthService.getUserFromToken.mockRejectedValue(new Error('Invalid format'));
          
          await authMiddleware(context, mockNext);
          
          expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith(token);
          expect(context.json).toHaveBeenCalledWith({ error: 'Invalid token' }, 401);
        }
      });

      it('should handle concurrent requests safely', async () => {
        const baseUser: User = {
          id: 'user-base',
          email: 'base@example.com',
          name: 'Base User',
          image: null,
          domain: 'example.com',
          provider: 'google',
          providerId: 'google-base',
          isAdmin: false,
          isActive: true,
          lastLogin: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const mockUser1 = { ...baseUser, id: 'user-1', email: 'user1@example.com' };
        const mockUser2 = { ...baseUser, id: 'user-2', email: 'user2@example.com' };
        const mockUser3 = { ...baseUser, id: 'user-3', email: 'user3@example.com' };

        const contexts = [
          createMockContext({ 'Authorization': 'Bearer token1' }),
          createMockContext({ 'Authorization': 'Bearer token2' }),
          createMockContext({ 'Authorization': 'Bearer token3' }),
        ];

        mockOAuthService.getUserFromToken
          .mockResolvedValueOnce(mockUser1)
          .mockResolvedValueOnce(mockUser2)
          .mockResolvedValueOnce(mockUser3);

        // Process all requests concurrently
        await Promise.all(contexts.map(context => authMiddleware(context, mockNext)));

        // Verify each request was handled correctly
        expect(contexts[0]?.set).toHaveBeenCalledWith('user', mockUser1);
        expect(contexts[1]?.set).toHaveBeenCalledWith('user', mockUser2);
        expect(contexts[2]?.set).toHaveBeenCalledWith('user', mockUser3);
        expect(mockNext).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('optionalAuthMiddleware', () => {
    describe('No Authentication Required', () => {
      it('should continue without authentication for missing header', async () => {
        const context = createMockContext();
        
        await optionalAuthMiddleware(context, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(context.json).not.toHaveBeenCalled();
        expect(context.set).not.toHaveBeenCalled();
        expect(mockOAuthService.getUserFromToken).not.toHaveBeenCalled();
      });

      it('should continue without authentication for malformed header', async () => {
        const malformedHeaders = [
          'Basic username:password',
          'Bearer', // no token
          'InvalidScheme token',
          'bearer token', // lowercase bearer
          'Token token123', // wrong scheme
        ];

        for (const authHeader of malformedHeaders) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': authHeader });
          
          await optionalAuthMiddleware(context, mockNext);
          
          expect(mockNext).toHaveBeenCalled();
          expect(context.json).not.toHaveBeenCalled();
          expect(context.set).not.toHaveBeenCalled();
          expect(mockOAuthService.getUserFromToken).not.toHaveBeenCalled();
        }
      });

      it('should continue without authentication for invalid tokens', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer invalid-token' });
        mockOAuthService.getUserFromToken.mockRejectedValue(new Error('Invalid token'));
        
        await optionalAuthMiddleware(context, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(context.json).not.toHaveBeenCalled();
        expect(context.set).not.toHaveBeenCalled();
        expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith('invalid-token');
      });
    });

    describe('Optional Authentication Success', () => {
      const mockUser: User = {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-123',
        isAdmin: true,
        isActive: true,
        lastLogin: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      it('should set user context for valid tokens', async () => {
        const context = createMockContext({ 'Authorization': 'Bearer valid-token' });
        mockOAuthService.getUserFromToken.mockResolvedValue(mockUser);
        
        await optionalAuthMiddleware(context, mockNext);
        
        expect(context.set).toHaveBeenCalledWith('user', mockUser);
        expect(mockNext).toHaveBeenCalled();
        expect(context.json).not.toHaveBeenCalled();
        expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith('valid-token');
      });

      it('should handle token extraction correctly', async () => {
        const testTokens = [
          'short',
          'very.long.jwt.token.with.many.segments',
          'token-with-dashes-and_underscores',
        ];

        for (const token of testTokens) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': `Bearer ${token}` });
          mockOAuthService.getUserFromToken.mockResolvedValue(mockUser);
          
          await optionalAuthMiddleware(context, mockNext);
          
          expect(mockOAuthService.getUserFromToken).toHaveBeenCalledWith(token);
          expect(context.set).toHaveBeenCalledWith('user', mockUser);
        }
      });
    });

    describe('Error Handling', () => {
      it('should handle authentication errors silently', async () => {
        const authErrors = [
          new Error('Token expired'),
          new Error('Invalid signature'),
          new Error('User not found'),
          new Error('Database connection failed'),
          new Error('Network timeout'),
        ];

        for (const error of authErrors) {
          vi.clearAllMocks();
          const context = createMockContext({ 'Authorization': 'Bearer error-token' });
          mockOAuthService.getUserFromToken.mockRejectedValue(error);
          
          await optionalAuthMiddleware(context, mockNext);
          
          expect(mockNext).toHaveBeenCalled();
          expect(context.json).not.toHaveBeenCalled();
          expect(context.set).not.toHaveBeenCalled();
        }
      });

      it('should not log sensitive information during optional auth failures', async () => {
        const sensitiveError = new Error('User admin@secret.com token sk_secret_123 invalid');
        const context = createMockContext({ 'Authorization': 'Bearer sensitive-token' });
        mockOAuthService.getUserFromToken.mockRejectedValue(sensitiveError);
        
        // Mock console.error to verify no sensitive logging
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        
        await optionalAuthMiddleware(context, mockNext);
        
        expect(mockNext).toHaveBeenCalled();
        expect(context.set).not.toHaveBeenCalled();
        
        // Should not log sensitive information
        expect(consoleSpy).not.toHaveBeenCalled();
        
        consoleSpy.mockRestore();
      });
    });
  });

  describe('Middleware Integration', () => {
    it('should work correctly in middleware chain', async () => {
      const mockUser: User = {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        image: null,
        domain: 'example.com',
        provider: 'google',
        providerId: 'google-123',
        isAdmin: false,
        isActive: true,
        lastLogin: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const context = createMockContext({ 'Authorization': 'Bearer valid-token' });
      mockOAuthService.getUserFromToken.mockResolvedValue(mockUser);
      
      // Mock next middleware that checks for user
      const nextMiddleware = vi.fn(async () => {
        const user = context.get('user');
        expect(user).toEqual(mockUser);
      });
      
      await authMiddleware(context, nextMiddleware);
      
      expect(context.set).toHaveBeenCalledWith('user', mockUser);
      expect(nextMiddleware).toHaveBeenCalled();
    });

    it('should return response immediately on auth failure', async () => {
      const context = createMockContext(); // No auth header
      const nextMiddleware = vi.fn();
      
      await authMiddleware(context, nextMiddleware);
      
      expect(context.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
      expect(nextMiddleware).not.toHaveBeenCalled();
    });
  });
});