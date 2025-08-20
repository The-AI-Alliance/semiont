/**
 * Tests for OAuth service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OAuthService } from '../../auth/oauth';
import { JWTService } from '../../auth/jwt';
import { prisma } from '../../db';
import { User } from '@prisma/client';
import { faker } from '@faker-js/faker';

// Mock JWT service
vi.mock('../../auth/jwt', () => ({
  JWTService: {
    isAllowedDomain: vi.fn(),
    generateToken: vi.fn(),
    verifyToken: vi.fn(),
  },
}));

// The prisma mock is already set up in setup.ts
const mockPrismaUser = vi.mocked(prisma.user);

describe('OAuth Service', () => {
  const mockGoogleUser = {
    id: 'google-123',
    email: 'test@example.com',
    name: 'Test User',
    picture: 'https://example.com/photo.jpg',
    verified_email: true,
  };

  const mockUser: User = {
    id: faker.string.uuid(),
    email: mockGoogleUser.email,
    name: mockGoogleUser.name,
    image: mockGoogleUser.picture || null,
    domain: 'example.com',
    provider: 'google',
    providerId: mockGoogleUser.id,
    isAdmin: false,
    isActive: true,
    termsAcceptedAt: null,
    lastLogin: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('verifyGoogleToken', () => {
    it('should verify valid Google access token', async () => {
      const result = await OAuthService.verifyGoogleToken('valid-access-token');
      
      expect(result).toEqual({
        id: 'google-123',
        email: 'test@example.com',
        verified_email: true,
        name: 'Test User',
        given_name: 'Test',
        family_name: 'User',
        picture: 'https://example.com/photo.jpg',
        locale: 'en'
      });
    });

    it('should throw error for invalid token', async () => {
      // This will be handled by MSW returning a 401
      await expect(
        OAuthService.verifyGoogleToken('invalid-token')
      ).rejects.toThrow('Failed to verify Google token');
    });

    it('should throw error for unverified email', async () => {
      // We need to add a handler for this case
      const { server } = await import('../mocks/server');
      const { http, HttpResponse } = await import('msw');
      
      server.use(
        http.get('https://www.googleapis.com/oauth2/v2/userinfo', () => {
          return HttpResponse.json({
            id: 'google-456',
            email: 'unverified@example.com',
            verified_email: false,
            name: 'Unverified User'
          });
        })
      );

      await expect(
        OAuthService.verifyGoogleToken('unverified-token')
      ).rejects.toThrow('Email not verified with Google');
    });
  });

  describe('createOrUpdateUser', () => {
    it('should create new user with allowed domain', async () => {
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(true);
      vi.mocked(JWTService.generateToken).mockReturnValue('mock-jwt-token');
      mockPrismaUser.findFirst.mockResolvedValue(null);
      mockPrismaUser.create.mockResolvedValue(mockUser);

      const result = await OAuthService.createOrUpdateUser(mockGoogleUser);

      expect(result).toEqual({
        user: mockUser,
        token: 'mock-jwt-token',
        isNewUser: true
      });

      expect(mockPrismaUser.create).toHaveBeenCalledWith({
        data: {
          email: mockGoogleUser.email,
          name: mockGoogleUser.name,
          image: mockGoogleUser.picture,
          provider: 'google',
          providerId: mockGoogleUser.id,
          domain: 'example.com',
          isAdmin: false,
          lastLogin: expect.any(Date),
        }
      });
    });

    it('should update existing user', async () => {
      const existingUser = { ...mockUser, lastLogin: new Date('2024-01-01') };
      
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(true);
      vi.mocked(JWTService.generateToken).mockReturnValue('mock-jwt-token');
      mockPrismaUser.findFirst.mockResolvedValue(existingUser);
      mockPrismaUser.update.mockResolvedValue({
        ...existingUser,
        lastLogin: new Date(),
      });

      const result = await OAuthService.createOrUpdateUser(mockGoogleUser);

      expect(result.isNewUser).toBe(false);
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: existingUser.id },
        data: {
          name: mockGoogleUser.name,
          image: mockGoogleUser.picture,
          provider: 'google',
          providerId: mockGoogleUser.id,
          domain: 'example.com',
          lastLogin: expect.any(Date),
        }
      });
    });

    it('should update existing user with no picture', async () => {
      const existingUser = { ...mockUser, lastLogin: new Date('2024-01-01') };
      const userWithoutPicture = { ...mockGoogleUser, picture: undefined };
      
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(true);
      vi.mocked(JWTService.generateToken).mockReturnValue('mock-jwt-token');
      mockPrismaUser.findFirst.mockResolvedValue(existingUser);
      mockPrismaUser.update.mockResolvedValue({
        ...existingUser,
        image: null,
        lastLogin: new Date(),
      });

      const result = await OAuthService.createOrUpdateUser(userWithoutPicture);

      expect(result.isNewUser).toBe(false);
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: existingUser.id },
        data: {
          name: userWithoutPicture.name,
          image: null,
          provider: 'google',
          providerId: userWithoutPicture.id,
          domain: 'example.com',
          lastLogin: expect.any(Date),
        }
      });
    });

    it('should throw error for disallowed domain', async () => {
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(false);

      await expect(
        OAuthService.createOrUpdateUser(mockGoogleUser)
      ).rejects.toThrow('Domain example.com is not allowed for authentication');
    });

    it('should handle users without picture', async () => {
      const userWithoutPicture = { ...mockGoogleUser, picture: undefined };
      
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(true);
      vi.mocked(JWTService.generateToken).mockReturnValue('mock-jwt-token');
      mockPrismaUser.findFirst.mockResolvedValue(null);
      mockPrismaUser.create.mockResolvedValue({
        ...mockUser,
        image: null,
      });

      await OAuthService.createOrUpdateUser(userWithoutPicture);

      expect(mockPrismaUser.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          image: null,
        })
      });
    });

    it('should handle email without domain (edge case)', async () => {
      const userWithInvalidEmail = { ...mockGoogleUser, email: 'invalidemail' };
      
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(true);
      vi.mocked(JWTService.generateToken).mockReturnValue('mock-jwt-token');
      mockPrismaUser.findFirst.mockResolvedValue(null);
      mockPrismaUser.create.mockResolvedValue({
        ...mockUser,
        domain: '',
      });

      await OAuthService.createOrUpdateUser(userWithInvalidEmail);

      expect(mockPrismaUser.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          domain: '',
        })
      });
    });

    it('should handle domain update for existing user with undefined domain', async () => {
      const userWithUndefinedDomain = { ...mockGoogleUser, email: 'user@' };
      const existingUser = { ...mockUser, domain: 'olddomain.com' };
      
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(true);
      vi.mocked(JWTService.generateToken).mockReturnValue('mock-jwt-token');
      mockPrismaUser.findFirst.mockResolvedValue(existingUser);
      mockPrismaUser.update.mockResolvedValue({
        ...existingUser,
        domain: '',
        lastLogin: new Date(),
      });

      await OAuthService.createOrUpdateUser(userWithUndefinedDomain);

      // Should call update without domain field when domain is undefined
      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: existingUser.id },
        data: {
          name: userWithUndefinedDomain.name,
          image: userWithUndefinedDomain.picture,
          provider: 'google',
          providerId: userWithUndefinedDomain.id,
          lastLogin: expect.any(Date),
        }
      });
    });

    it('should handle user with no name in JWT payload', async () => {
      const userWithoutName = { ...mockGoogleUser, name: '' };
      
      vi.mocked(JWTService.isAllowedDomain).mockReturnValue(true);
      vi.mocked(JWTService.generateToken).mockReturnValue('mock-jwt-token');
      mockPrismaUser.findFirst.mockResolvedValue(null);
      mockPrismaUser.create.mockResolvedValue({
        ...mockUser,
        name: '',
      });

      const result = await OAuthService.createOrUpdateUser(userWithoutName);

      // JWT payload should NOT have name field when user.name is falsy
      expect(JWTService.generateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.any(String),
          email: userWithoutName.email,
          // name field should be omitted when falsy, not set to undefined
          domain: 'example.com',
          provider: 'google',
          isAdmin: false,
        })
      );
      
      // Verify name field is not present when user.name is falsy
      const generateTokenCall = vi.mocked(JWTService.generateToken).mock.calls[0][0];
      expect('name' in generateTokenCall).toBe(false);
    });
  });

  describe('getUserFromToken', () => {
    it('should get user from valid JWT token', async () => {
      const mockPayload: any = {
        userId: mockUser.id,
        email: mockUser.email,
        name: mockUser.name,
        domain: mockUser.domain,
        provider: mockUser.provider,
        isAdmin: mockUser.isAdmin,
      };

      vi.mocked(JWTService.verifyToken).mockReturnValue(mockPayload);
      mockPrismaUser.findUnique.mockResolvedValue(mockUser);

      const result = await OAuthService.getUserFromToken('valid-jwt-token');

      expect(result).toEqual(mockUser);
      expect(JWTService.verifyToken).toHaveBeenCalledWith('valid-jwt-token');
      expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.id }
      });
    });

    it('should throw error for invalid token', async () => {
      vi.mocked(JWTService.verifyToken).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(
        OAuthService.getUserFromToken('invalid-token')
      ).rejects.toThrow('Invalid token');
    });

    it('should throw error if user not found', async () => {
      const mockPayload: any = {
        userId: 'non-existent-user',
        email: 'ghost@example.com',
      };

      vi.mocked(JWTService.verifyToken).mockReturnValue(mockPayload);
      mockPrismaUser.findUnique.mockResolvedValue(null);

      await expect(
        OAuthService.getUserFromToken('valid-jwt-token')
      ).rejects.toThrow('User not found or inactive');
    });

    it('should throw error if user is inactive', async () => {
      const inactiveUser = { ...mockUser, isActive: false };
      const mockPayload: any = {
        userId: inactiveUser.id,
        email: inactiveUser.email,
      };

      vi.mocked(JWTService.verifyToken).mockReturnValue(mockPayload);
      mockPrismaUser.findUnique.mockResolvedValue(inactiveUser);

      await expect(
        OAuthService.getUserFromToken('valid-jwt-token')
      ).rejects.toThrow('User not found or inactive');
    });
  });
});