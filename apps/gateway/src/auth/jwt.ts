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
 * The JWT_SECRET contract, in one place: present, and every member at least 32
 * characters.
 *
 * `JWT_SECRET` is an ordered **key ring** — a comma-separated list where the
 * FIRST value signs and EVERY value verifies. A single value (the ordinary
 * case) is simply a ring of one. The ring exists so that changing the signing
 * secret is a soft transition rather than a cliff: set `JWT_SECRET=<new>,<old>`
 * and every outstanding token keeps verifying until its next refresh re-mints
 * it under the new key, then drop the tail. Without it, a secret change
 * invalidates every live access AND refresh token at once — and refresh cannot
 * heal it, because refresh must itself verify a token first.
 *
 * Comma is unambiguous as a delimiter: generated secrets are hex
 * (`semiont start`) and the documented manual recipe is `openssl rand -hex 32`.
 *
 * Exported so index.ts can check it among its other module-scope requirements
 * (SEMIONT_ROOT, services.gateway) — i.e. before startMakeMeaning dials the
 * graph and vector stores. Failing a millisecond in beats failing after those
 * connections are up, and both paths enforce the same rule because there is
 * only one copy of it.
 */
export function requireJwtSecret(): string[] {
  const raw = process.env.JWT_SECRET;
  if (!raw) {
    throw new Error(
      'JWT_SECRET is not set. `semiont start` generates one per knowledge base ' +
      'and injects it; set JWT_SECRET explicitly to override, or in test setup.'
    );
  }
  const ring = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (ring.length === 0) {
    throw new Error('JWT_SECRET is empty');
  }
  // EACH member, not the joined string: `<valid>,short` is over 32 characters
  // in total while carrying a secret that is not.
  if (ring.some(s => s.length < 32)) {
    throw new Error('JWT_SECRET must be at least 32 characters long (each value, if a comma-separated ring)');
  }
  return ring;
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

  private static requireSecret(): string[] {
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
  //
  // `current` signs; `[current, ...previous]` verify (see requireJwtSecret).
  private static getSecrets(): { current: string; previous: string[] } {
    const [current, ...previous] = this.requireSecret();
    return { current: current!, previous };
  }

  /** The signing key — the head of the ring. Never falls back down it. */
  private static getSecret(): string {
    return this.getSecrets().current;
  }

  /**
   * Verify against each ring member in turn, newest first.
   *
   * Returns the decoded payload from the first secret that accepts the
   * signature. Expiry and not-yet-valid are properties of the TOKEN rather than
   * of which key signed it, so they abort immediately instead of walking the
   * ring — and they must be tested BEFORE `JsonWebTokenError`, which they both
   * extend. Getting that order wrong is how an expired token comes back as
   * "Invalid token signature".
   */
  private static verifyAcrossRing(token: string, onExpired: () => Error): jwt.JwtPayload | string {
    const { current, previous } = this.getSecrets();
    for (const secret of [current, ...previous]) {
      try {
        return jwt.verify(token, secret);
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) throw onExpired();
        if (error instanceof jwt.NotBeforeError) throw new Error('Token not active yet');
        if (error instanceof jwt.JsonWebTokenError) continue; // wrong key — try the next
        throw error;
      }
    }
    throw new jwt.JsonWebTokenError('invalid signature');
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
    let decoded: jwt.JwtPayload | string;
    try {
      // Signature: accepted by any secret in the ring (expiry/not-before abort).
      decoded = this.verifyAcrossRing(token, () => new Error('Token has expired'));
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid token signature');
      }
      throw error;
    }

    // Payload validation is terminal — a correctly signed token with a bad
    // payload is not a "try the next key" case, so it sits outside the ring loop.
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
  }

  static generateMediaToken(resourceId: string, userId: string): string {
    const payload = { purpose: 'media', sub: resourceId, userId };
    return jwt.sign(payload, this.getSecret(), { expiresIn: '5m' });
  }

  static verifyMediaToken(token: string, resourceId: string): void {
    let decoded: jwt.JwtPayload;
    try {
      decoded = this.verifyAcrossRing(token, () => new Error('Media token expired')) as jwt.JwtPayload;
    } catch (error) {
      if (error instanceof Error && error.message === 'Media token expired') throw error;
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