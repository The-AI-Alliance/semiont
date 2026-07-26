import jwt from 'jsonwebtoken';
import { JWTPayloadSchema } from '../types/jwt-types';
import type { JWTPayload as ValidatedJWTPayload } from '../types/jwt-types';
import type { UserId, Email } from '@semiont/core';
import { userId as makeUserId, email as makeEmail } from '@semiont/core';

export interface JWTPayload {
  userId: UserId;
  email: Email;
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

/**
 * The JWT_SECRET contract, in one place: present, and at least 32 characters.
 *
 * Exported so index.ts can check it among its other module-scope requirements
 * (SEMIONT_ROOT, services.backend) — i.e. before startMakeMeaning dials the
 * graph and vector stores. Failing a millisecond in beats failing after those
 * connections are up, and both paths enforce the same rule because there is
 * only one copy of it.
 */
export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. `semiont start` generates one per knowledge base ' +
      'and injects it; set JWT_SECRET explicitly to override, or in test setup.'
    );
  }
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }
  return secret;
}

export class JWTService {
  private static siteConfig: SiteConfig | null = null;

  /**
   * Initialize JWTService with application configuration
   * Must be called once at application startup before using any other methods
   *
   * This is the startup GATE for everything needed to sign a token, JWT_SECRET
   * included. The secret is otherwise read lazily per operation (getSecret), so
   * without a gate an absent one surfaced at the first sign-in — after the
   * container had already reported healthy — rather than refusing to start.
   */
  static initialize(config: { site?: SiteConfig }): void {
    if (!config.site?.domain) {
      throw new Error('site.domain is required in environment config');
    }

    if (!config.site?.oauthAllowedDomains || !Array.isArray(config.site.oauthAllowedDomains)) {
      throw new Error('site.oauthAllowedDomains is required in environment config');
    }

    // Fail here rather than at first use: validating the same rules getSecret
    // enforces, at a point where the process can still decline to start.
    this.requireSecret();

    this.siteConfig = {
      domain: config.site.domain,
      oauthAllowedDomains: config.site.oauthAllowedDomains
    };
  }

  private static requireSecret(): string {
    return requireJwtSecret();
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
   * Get the deployment domain to use for issuing agent identities.
   * Used by `/api/tokens/agent` to mint DIDs of the shape
   * `did:web:<domain>:agents:<provider>:<model>`.
   */
  static getDomainForAgent(): string {
    const config = this.getSiteConfig();
    if (!config.domain) {
      throw new Error('site.domain is required to issue agent tokens');
    }
    return config.domain;
  }

  /**
   * The email domains permitted to authenticate — `site.oauthAllowedDomains`,
   * validated at startup by initialize().
   *
   * Exposed so nothing has to re-read this from the environment. The admin
   * endpoint GET /api/admin/oauth/config used to parse an OAUTH_ALLOWED_DOMAINS
   * env var, which made two sources of truth for one fact; the retired CLI set
   * that var, so when it went the endpoint became a guaranteed 500.
   */
  static getAllowedDomains(): string[] {
    return this.getSiteConfig().oauthAllowedDomains ?? [];
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
  
  // Injected by `semiont start` (generated once per knowledge base and kept, so
  // tokens survive a restart), or set explicitly to override. Still re-read per
  // operation rather than cached: initialize() has already gated it, so this is
  // the cheap read, not the check.
  private static getSecret(): string {
    return this.requireSecret();
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

      // Brand the string types for type safety
      return {
        ...result.data,
        userId: makeUserId(result.data.userId),
        email: makeEmail(result.data.email),
      };
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

  static generateMediaToken(resourceId: string, userId: string): string {
    const payload = { purpose: 'media', sub: resourceId, userId };
    return jwt.sign(payload, this.getSecret(), { expiresIn: '5m' });
  }

  static verifyMediaToken(token: string, resourceId: string): void {
    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.getSecret()) as jwt.JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) throw new Error('Media token expired');
      throw new Error('Invalid media token');
    }
    if (decoded['purpose'] !== 'media') throw new Error('Invalid media token');
    if (decoded['sub'] !== resourceId) throw new Error('Media token resource mismatch');
  }

  static isAllowedDomain(email: Email): boolean {
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