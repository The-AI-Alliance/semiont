import * as jwt from 'jsonwebtoken';
import { loadEnvironmentConfig, type EnvironmentConfig } from '@semiont/config';
import { JWTPayloadSchema, validateData } from '../validation/schemas';
import { JWTPayload as ValidatedJWTPayload } from '@semiont/api-types';

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
  private static configCache: EnvironmentConfig | null = null;
  
  /**
   * Get configuration, loading it lazily if needed
   */
  private static getConfig(): EnvironmentConfig {
    if (!this.configCache) {
      // Try to load from environment if specified
      const environment = process.env.SEMIONT_ENV;
      if (environment && environment !== 'unit' && environment !== 'test') {
        try {
          this.configCache = loadEnvironmentConfig(environment);
        } catch (error) {
          // Fallback to default config for CI/testing
          console.warn('Could not load environment config, using defaults:', error);
          this.configCache = {
            name: 'test',
            site: {
              oauthAllowedDomains: ['example.com', 'test.example.com']
            }
          };
        }
      } else {
        // For unit tests and CI, use default config
        this.configCache = {
          name: 'test',
          site: {
            oauthAllowedDomains: ['example.com', 'test.example.com']
          }
        };
      }
    }
    return this.configCache;
  }
  
  /**
   * Override configuration for testing purposes
   * @param config The configuration to use
   */
  static setConfig(config: EnvironmentConfig): void {
    this.configCache = config;
  }
  
  /**
   * Reset configuration cache (useful for testing)
   */
  static resetConfig(): void {
    this.configCache = null;
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

  static generateToken(payload: Omit<ValidatedJWTPayload, 'iat' | 'exp'>): string {
    const config = this.getConfig();
    return jwt.sign(payload, this.getSecret(), {
      expiresIn: '7d',
      issuer: config.site?.domain || 'localhost',
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
    const config = this.getConfig();
    const allowedDomains = config.site?.oauthAllowedDomains || [];
    return allowedDomains.includes(domain);
  }
}