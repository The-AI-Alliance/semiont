import { DatabaseConnection } from '../db';
import { JWTService } from './jwt';
import { User } from '@prisma/client';
import { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';

export interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  picture?: string;
  verified_email: boolean;
}

export interface CreateUserResult {
  user: User;
  token: string;
  isNewUser: boolean;
}

export class OAuthService {
  static async verifyGoogleToken(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${accessToken}`);
    
    if (!response.ok) {
      throw new Error('Failed to verify Google token');
    }

    const userInfo = await response.json() as GoogleUserInfo;
    
    if (!userInfo.verified_email) {
      throw new Error('Email not verified with Google');
    }

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
      userId: user.id,
      email: user.email,
      ...(user.name && { name: user.name }),
      domain: user.domain,
      provider: user.provider,
      isAdmin: user.isAdmin,
    };

    const token = JWTService.generateToken(jwtPayload);

    return { user, token, isNewUser };
  }

  static async getUserFromToken(token: string): Promise<User> {
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
  
  static async acceptTerms(userId: string): Promise<User> {
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