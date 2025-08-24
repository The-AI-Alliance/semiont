import * as jwt from 'jsonwebtoken';
import { JWTPayloadSchema, validateData } from '../validation/schemas';
import { JWTPayload as ValidatedJWTPayload } from '@semiont/api-types';

export interface JWTPayload {
  userId: string;
  email: string;
  name?: string;
  domain: string;
  provider: string;
  type?: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

interface SiteConfig {
  domain?: string;
  oauthAllowedDomains?: string[];
}

export class JWTService {
  private static siteConfig: SiteConfig | null = null;
  
  /**
   * Get site configuration from environment variables
   * FAILS HARD if not properly configured (except in test mode)
   */
  private static getSiteConfig(): SiteConfig {
    if (!this.siteConfig) {
      const environment = process.env.SEMIONT_ENV;
      
      // Test environments use test defaults
      if (environment === 'unit' || environment === 'test') {
        this.siteConfig = {
          domain: 'localhost',
          oauthAllowedDomains: ['example.com', 'test.example.com']
        };
        return this.siteConfig;
      }
      
      // Production/staging must have proper configuration
      const domain = process.env.SITE_DOMAIN;
      const allowedDomains = process.env.OAUTH_ALLOWED_DOMAINS;
      
      if (!domain) {
        throw new Error('SITE_DOMAIN environment variable is required for JWT issuer');
      }
      
      if (!allowedDomains) {
        throw new Error('OAUTH_ALLOWED_DOMAINS environment variable is required for authentication');
      }
      
      this.siteConfig = {
        domain,
        oauthAllowedDomains: allowedDomains.split(',').map(d => d.trim())
      };
    }
    return this.siteConfig;
  }
  
  /**
   * Override configuration for testing purposes
   * @param config The configuration to use
   */
  static setTestConfig(domain: string, oauthAllowedDomains: string[]): void {
    this.siteConfig = { domain, oauthAllowedDomains };
  }
  
  /**
   * Reset configuration cache (useful for testing)
   */
  static resetConfig(): void {
    this.siteConfig = null;
  }
  
  private static getSecret(): string {
    // JWT secret comes from AWS Secrets Manager (injected as env var by ECS) or test setup
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET environment variable not found. This should be injected by AWS Secrets Manager in production or set in test setup.');
    }
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long');
    }
    return secret;
  }

  static generateToken(
    payload: Omit<ValidatedJWTPayload, 'iat' | 'exp'>, 
    expiresIn: string = '7d'
  ): string {
    const config = this.getSiteConfig();
    // Convert payload to plain object for jwt.sign
    const tokenPayload: Record<string, any> = { ...payload };
    return jwt.sign(tokenPayload, this.getSecret(), {
      expiresIn: expiresIn,
      issuer: config.domain || 'localhost',
    } as jwt.SignOptions);
  }

  static verifyToken(token: string): ValidatedJWTPayload {
    try {
      // First, verify JWT signature and basic structure
      const decoded = jwt.verify(token, this.getSecret());
      
      // Then validate the payload structure and content
      const validation = validateData(JWTPayloadSchema, decoded);
      
      if (!validation.success) {
        throw new Error(`Invalid token payload: ${validation.error}`);
      }
      
      return validation.data as ValidatedJWTPayload;
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
    const config = this.getSiteConfig();
    const allowedDomains = config.oauthAllowedDomains || [];
    return allowedDomains.includes(domain);
  }
}