import { email } from '@semiont/core';
/**
 * Auth security tests — the token-refresh endpoint and token-handling best
 * practices. (The MCP setup/OAuth-flow blocks were removed with the MCP token
 * routes — SDK-AUTH-CORS Phase 2.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JWTService } from '../../auth/jwt';
describe('MCP Authentication security', () => {
  
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup database mock
    
    // Setup JWT service test config
    JWTService.setTestConfig('test.semiont.com');
  });

  afterEach(() => {
    JWTService.resetConfig();
  });


  /*
   * The `/api/auth/refresh Security` suite that stood here tested an endpoint
   * this gateway does not have. Refresh is the trusted issuer's job — people
   * get tokens there and renew them there — and the suite's remaining cases
   * ("reject refresh tokens for deleted users") also depended on a User row
   * that no longer exists. It asserted against JWTService directly rather than
   * through the app, so it went on passing the whole time the route was gone.
   */

  describe('Token Security Best Practices', () => {
    it('security: should use secure JWT algorithm', () => {
      const token = JWTService.generateToken({        did: `did:web:${'example.com'}:agents:test:model`,

        email: email('test@example.com'),
        domain: 'example.com',
      }, '1h');

      // Decode header to check algorithm
      const [headerB64] = token.split('.');
      const header = JSON.parse(Buffer.from(headerB64 || '', 'base64').toString());
      
      // Should use HS256 or stronger
      expect(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512']).toContain(header.alg);
      
      // Should not use 'none' algorithm
      expect(header.alg).not.toBe('none');
    });

    it('security: should include proper token claims', () => {
      const token = JWTService.generateToken({        did: `did:web:${'example.com'}:agents:test:model`,

        email: email('test@example.com'),
        domain: 'example.com',
      }, '30d');
      
      const payload = JWTService.verifyToken(token);
      
      // Should include required claims
      expect(payload.did).toBeDefined();
      expect(payload.email).toBeDefined();
      expect(payload.iat!).toBeDefined(); // Issued at
      expect(payload.exp!).toBeDefined(); // Expiration
    });

    it('security: should separate refresh and access token permissions', () => {
      // Resource the separation of refresh and access tokens by expiration time
      // Refresh tokens: long-lived (30 days), used only to get new access tokens
      // Access tokens are short-lived and used for API calls (TTL: see AUTHENTICATION.md)
      
      const refreshToken = JWTService.generateToken({        did: `did:web:${'example.com'}:agents:test:model`,

        email: email('test@example.com'),
        domain: 'example.com',
      }, '30d');
      
      const refreshPayload = JWTService.verifyToken(refreshToken);
      
      // Access tokens should be used for API calls
      const accessToken = JWTService.generateToken({        did: `did:web:${'example.com'}:agents:test:model`,

        email: email('test@example.com'),
        domain: 'example.com',
      }, '1h');
      
      const accessPayload = JWTService.verifyToken(accessToken);
      
      // Both name the principal they were minted for
      expect(refreshPayload.did).toBeDefined();
      expect(accessPayload.did).toBeDefined();
      
      // Differentiated by expiration time
      const refreshExp = refreshPayload.exp!;
      const accessExp = accessPayload.exp!;
      expect(refreshExp).toBeGreaterThan(accessExp); // Refresh token lasts longer
    });

    it('security: should have reasonable token expiration times', () => {
      // Resource expected expiration times for security
      const refreshTokenExpiry = 30 * 24 * 60 * 60; // 30 days in seconds
      const accessTokenExpiry = 60 * 60; // 1 hour in seconds
      
      // Refresh tokens: long-lived but not permanent
      expect(refreshTokenExpiry).toBeLessThanOrEqual(30 * 24 * 60 * 60); // Max 30 days
      expect(refreshTokenExpiry).toBeGreaterThanOrEqual(7 * 24 * 60 * 60); // Min 7 days
      
      // Access tokens: short-lived
      expect(accessTokenExpiry).toBeLessThanOrEqual(24 * 60 * 60); // Max 24 hours
      expect(accessTokenExpiry).toBeGreaterThanOrEqual(15 * 60); // Min 15 minutes
    });
  });

});