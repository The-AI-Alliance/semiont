import * as jwt from 'jsonwebtoken';
import { CONFIG } from '../config';
import { JWTPayloadSchema, validateData, ValidatedJWTPayload } from '../validation/schemas';

export interface JWTPayload {
  userId: string;
  email: string;
  name?: string;
  domain: string;
  provider: string;
  iat?: number;
  exp?: number;
}

export class JWTService {
  private static getSecret(): string {
    return CONFIG.JWT_SECRET; // Now guaranteed to exist and be valid
  }

  static generateToken(payload: Omit<ValidatedJWTPayload, 'iat' | 'exp'>): string {
    return jwt.sign(payload, this.getSecret(), {
      expiresIn: '7d',
      issuer: CONFIG.DOMAIN,
    });
  }

  static verifyToken(token: string): ValidatedJWTPayload {
    try {
      // First, verify JWT signature and basic structure
      const decoded = jwt.verify(token, this.getSecret());
      
      // Then validate the payload structure and content
      const validation = validateData(JWTPayloadSchema, decoded);
      
      if (!validation.success) {
        console.error('JWT payload validation failed:', validation.error);
        throw new Error(`Invalid token payload: ${validation.error}`);
      }
      
      return validation.data;
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid token signature');
      }
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Token has expired');
      }
      if (error instanceof jwt.NotBeforeError) {
        throw new Error('Token not active yet');
      }
      
      // Re-throw validation errors or other errors
      throw error;
    }
  }

  static isAllowedDomain(email: string): boolean {
    const parts = email.split('@');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return false;
    }
    const domain = parts[1];
    return CONFIG.OAUTH_ALLOWED_DOMAINS.includes(domain);
  }
}