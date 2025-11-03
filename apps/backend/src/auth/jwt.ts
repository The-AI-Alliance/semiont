import * as jwt from 'jsonwebtoken';
import { JWTPayloadSchema } from '../types/jwt-types';
import type { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';
import type { EnvironmentConfig } from '@semiont/core';

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
   * Initialize JWTService with application configuration
   * Must be called once at application startup before using any other methods
   */
  static initialize(config: EnvironmentConfig): void {
    if (!config.site?.domain) {
      throw new Error('site.domain is required in environment config');
    }

    if (!config.site?.oauthAllowedDomains || !Array.isArray(config.site.oauthAllowedDomains)) {
      throw new Error('site.oauthAllowedDomains is required in environment config');
    }

    this.siteConfig = {
      domain: config.site.domain,
      oauthAllowedDomains: config.site.oauthAllowedDomains
    };
  }

  /**
   * Get site configuration (must call initialize() first)
   */
  private static getSiteConfig(): SiteConfig {
    if (!this.siteConfig) {
      throw new Error('JWTService not initialized. Call JWTService.initialize(config) at application startup.');
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
      const result = JWTPayloadSchema.safeParse(decoded);

      if (!result.success) {
        throw new Error(`Invalid token payload: ${result.error.message}`);
      }

      return result.data;
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