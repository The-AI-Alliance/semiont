import { DatabaseConnection } from '../db';
import { JWTService } from './jwt';
import { User } from '@prisma/client';
import { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';
import { type UserId, userId as makeUserId } from '@semiont/core';
import { type AccessToken, type Email, type GoogleCredential, accessToken as makeAccessToken, email as makeEmail } from '@semiont/api-client';

export interface GoogleUserInfo {
  id: string;
  email: Email;
  name: string;
  picture?: string;
  verified_email: boolean;
}

export interface CreateUserResult {
  user: User;
  token: AccessToken;
  isNewUser: boolean;
}

export class OAuthService {
  static async verifyGoogleToken(accessToken: GoogleCredential): Promise<GoogleUserInfo> {
    const response = await fetch(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${accessToken}`);

    if (!response.ok) {
      throw new Error('Failed to verify Google token');
    }

    const rawUserInfo = await response.json() as { id: string; email: string; name: string; picture?: string; verified_email: boolean };

    if (!rawUserInfo.verified_email) {
      throw new Error('Email not verified with Google');
    }

    // Brand the email for type safety
    const userInfo: GoogleUserInfo = {
      ...rawUserInfo,
      email: makeEmail(rawUserInfo.email),
    };

    return userInfo;
  }

  static async createOrUpdateUser(googleUser: GoogleUserInfo): Promise<CreateUserResult> {
    const domain = googleUser.email.split('@')[1];
    
    // Check if domain is allowed
    if (!JWTService.isAllowedDomain(googleUser.email)) {
      throw new Error(`Domain ${domain} is not allowed for authentication`);
    }

    // Get database connection
    const prisma = DatabaseConnection.getClient();

    // Find or create user
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: googleUser.email },
          { provider: 'google', providerId: googleUser.id }
        ]
      }
    });

    let user;
    let isNewUser = false;

    if (existingUser) {
      // Update existing user (preserve admin status)
      user = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          name: googleUser.name,
          image: googleUser.picture || null,
          provider: 'google',
          providerId: googleUser.id,
          ...(domain ? { domain } : {}),
          // Don't change isAdmin - it's managed via CLI command
          lastLogin: new Date(),
        }
      });
    } else {
      // Create new user (default to non-admin, use CLI to grant admin)
      user = await prisma.user.create({
        data: {
          email: googleUser.email,
          name: googleUser.name,
          image: googleUser.picture || null,
          provider: 'google',
          providerId: googleUser.id,
          domain: domain || '',
          isAdmin: false, // Default to non-admin for security
          lastLogin: new Date(),
        }
      });
      isNewUser = true;
    }

    // Generate JWT token
    const jwtPayload: Omit<ValidatedJWTPayload, 'iat' | 'exp'> = {
      userId: makeUserId(user.id),
      email: makeEmail(user.email),
      ...(user.name && { name: user.name }),
      domain: user.domain,
      provider: user.provider,
      isAdmin: user.isAdmin,
    };

    const token = makeAccessToken(JWTService.generateToken(jwtPayload));

    return { user, token, isNewUser };
  }

  static async getUserFromToken(token: AccessToken): Promise<User> {
    const payload = JWTService.verifyToken(token);

    if (!payload.userId) {
      throw new Error('Invalid token: missing userId');
    }

    const prisma = DatabaseConnection.getClient();
    const user = await prisma.user.findUnique({
      where: { id: payload.userId }
    });

    if (!user || !user.isActive) {
      throw new Error('User not found or inactive');
    }

    return user;
  }

  static async acceptTerms(userId: UserId): Promise<User> {
    const prisma = DatabaseConnection.getClient();

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        termsAcceptedAt: new Date(),
      }
    });

    return user;
  }
}