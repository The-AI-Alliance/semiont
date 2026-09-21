/**
 * The HMAC path of `principalFromToken`: a gateway-signed token resolves to a
 * principal built from its own claims, and is refused when the signature or
 * the payload shape does not hold up.
 *
 * There is no database read on this path any more, and so no "row is gone"
 * case. The gateway is both the minter and the verifier of these tokens, so a
 * valid signature means this process asserted these facts itself — a lookup
 * could only have produced a second answer capable of disagreeing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { accessToken, email as makeEmail } from '@semiont/core';
import { JWTService } from '../../auth/jwt';
import { principalFromGatewayToken } from '../../identity/principal';

const AGENT_DID = 'did:web:test.local:agents:anthropic:claude';

function mintToken(overrides: Partial<{ did: string; email: string; name: string; domain: string }> = {}) {
  return accessToken(JWTService.generateToken({
    did: overrides.did ?? AGENT_DID,
    email: makeEmail(overrides.email ?? 'claude@agents.test.local'),
    name: overrides.name ?? 'anthropic claude',
    domain: overrides.domain ?? 'test.local',
  }, '1h'));
}

describe('principalFromGatewayToken', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: 'test.local' },
    });
  });

  it('builds the principal from the claims the token carries', () => {
    const principal = principalFromGatewayToken(mintToken());

    expect(principal).toEqual({
      did: AGENT_DID,
      email: 'claude@agents.test.local',
      name: 'anthropic claude',
      image: null,
      domain: 'test.local',
    });
  });

  it('carries the DID through verbatim, since it is what events attribute to', () => {
    const did = 'did:web:test.local:agents:ollama:gemma2%3A27b';

    expect(principalFromGatewayToken(mintToken({ did })).did).toBe(did);
  });

  /**
   * An agent's address lives in an `agents.<host>` namespace while its domain
   * is the deployment's, so the domain is NOT the email's suffix here. Carried
   * rather than re-derived for exactly that reason.
   */
  it('keeps the deployment domain, which is not the agent email suffix', () => {
    const principal = principalFromGatewayToken(
      mintToken({ email: 'ollama-gemma@agents.test.local', domain: 'test.local' }),
    );

    expect(principal.domain).toBe('test.local');
    expect(principal.email.split('@')[1]).toBe('agents.test.local');
  });

  it('refuses a token the key ring did not sign', () => {
    expect(() => principalFromGatewayToken(accessToken('not.a.token'))).toThrow();
  });

  it('refuses a correctly signed token whose payload does not parse', () => {
    const bad = accessToken(
      // Signed by us, but naming no DID — the payload check is terminal and
      // separate from the signature check.
      JWTService.generateToken({ did: '', email: makeEmail('x@example.com'), domain: 'example.com' }, '1h'),
    );

    expect(() => principalFromGatewayToken(bad)).toThrow(/Invalid token payload/);
  });
});
