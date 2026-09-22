/**
 * Tests for `/api/tokens/agent` — software-agent token exchange.
 *
 * The caller authenticates at the trusted issuer as its own SERVICE ACCOUNT and
 * presents that token here; what it receives is an agent token for a
 * (provider, model) identity. Two different identities on purpose: the service
 * account is the process, the agent DID is the work, and one process holds
 * several agent identities when job types are configured with different models.
 *
 * This replaced a single shared secret in the request body, which granted any
 * agent identity to anyone holding it and could only be rotated by restarting
 * the stack.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { app } from '../../index';
import { JWTService } from '../../auth/jwt';
import { configureTrustedIssuer } from '../../identity/trusted-issuer';
import { SERVICE_ROLE } from '../../identity/agent-minter';
import { fixtureIssuer, type FixtureIssuer } from '../fixtures/issuer';
import { WORKER_ROLE, type components } from '@semiont/core';

type ErrorResponse = components['schemas']['ErrorResponse'];


const SITE_DOMAIN = 'test.local';
const ORIGIN = 'https://issuer.test';
const AUDIENCE = 'https://example.github.io/test-kb';

let issuer: FixtureIssuer;

/** A service-account token carrying the role that authorizes minting. */
async function sidecarToken(claims: Record<string, unknown> = {}) {
  return issuer.token({ claims: { azp: 'semiont-weaver', roles: [SERVICE_ROLE], ...claims } });
}

/** The request every successful case makes, differing only in what it asks for. */
async function mint(body: Record<string, unknown>, token?: string) {
  const bearer = token ?? (await sidecarToken());
  return app.request('/api/tokens/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tokens/agent', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: SITE_DOMAIN },
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    issuer = await fixtureIssuer(ORIGIN, { audience: AUDIENCE });
    configureTrustedIssuer({ type: 'oidc', issuer: ORIGIN, subjectClaim: 'sub' }, { audience: AUDIENCE, domain: SITE_DOMAIN });
  });

  describe('successful exchange', () => {
    it('issues a JWT and returns the agent DID for valid (provider, model)', async () => {

      const response = await mint({
          provider: 'ollama',
          model: 'gemma2:27b',
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { token: string; did: string };

      expect(data.did).toBe('did:web:test.local:agents:ollama:gemma2%3A27b');
      expect(typeof data.token).toBe('string');
      expect(data.token.split('.')).toHaveLength(3);
    });

    /**
     * An agent token is the one credential here with no revocation behind it:
     * the account is synthetic, so there is nothing at the issuer to disable,
     * and rotating the shared secret stops new mints without touching tokens
     * already handed out. Its lifetime IS the revocation window, so this
     * bounds it. It was a day.
     *
     * The bound is asserted on the token's own `exp` claim because that claim
     * is what every holder schedules its re-authentication from — sidecars via
     * `startAgentSession`, workers via `SemiontSession`. Nothing restates the
     * number, so this is the only place it can be checked.
     */
    it('signs a lifetime short enough to serve as the revocation window', async () => {

      const response = await mint({
          provider: 'ollama',
          model: 'gemma2:27b',
      });

      const { token } = await response.json() as { token: string };
      const payload = JWTService.verifyToken(token as never);

      expect(payload.exp).toBeDefined();
      expect(payload.iat).toBeDefined();
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60 * 60);
    });

    it('JWT carries the agent DID in `agentDid` so the bus uses it as `_userId`', async () => {

      const response = await mint({
          provider: 'ollama',
          model: 'gemma2:27b',
      });

      const { token } = await response.json() as { token: string };
      const payload = JWTService.verifyToken(token as never);
      expect(payload.did).toBe('did:web:test.local:agents:ollama:gemma2%3A27b');
    });

    /**
     * The carry half of EXTRACT-JOBS P0: worker-ness is a capability the realm
     * grants the minting client (WORKER_ROLE), and it must SURVIVE onto the
     * agent token — the agent token is what the worker later claims jobs with,
     * and the service-account token that carried the grant is long gone by then.
     * The dispatcher authorizes the claim by reading exactly this.
     */
    it('stamps the worker capability onto the agent token when a worker minted it', async () => {
      const workerToken = await sidecarToken({ azp: 'semiont-worker', roles: [SERVICE_ROLE, WORKER_ROLE] });
      const response = await mint({ provider: 'ollama', model: 'gemma2:27b' }, workerToken);

      expect(response.status).toBe(200);
      const { token } = await response.json() as { token: string };
      const payload = JWTService.verifyToken(token as never);
      expect(payload.roles, 'the agent may claim jobs on the worker\'s behalf').toContain(WORKER_ROLE);
      // NEVER the service role: an agent is not a service account and must not be
      // able to mint further agent tokens.
      expect(payload.roles).not.toContain(SERVICE_ROLE);
    });

    it('stamps no capability when a non-worker service minted the agent token', async () => {
      // The default sidecar is the weaver — a service, not a worker.
      const response = await mint({ provider: 'ollama', model: 'gemma2:27b' });

      expect(response.status).toBe(200);
      const { token } = await response.json() as { token: string };
      const payload = JWTService.verifyToken(token as never);
      // Absent or empty — never carrying the worker role, so its job:claim is refused.
      expect(payload.roles ?? []).not.toContain(WORKER_ROLE);
    });

    /**
     * No row is written any more, so the synthetic address is asserted where it
     * actually matters: inside the minted token. That is the copy every later
     * request validates, and an address that fails `email()` there breaks every
     * `/bus/subscribe` the worker makes — the regression this guards.
     */
    it('places the synthetic email in the agents.<host> namespace, not the deployment domain', async () => {
      const response = await mint({
          provider: 'ollama',
          model: 'gemma2:27b',
      });

      const { token } = await response.json() as { token: string };
      const payload = JWTService.verifyToken(token as never);
      expect(payload.email.endsWith(`@agents.${SITE_DOMAIN}`)).toBe(true);
    });

    it('strips the port from a host:port deployment domain when forming the synthetic email', async () => {
      // The DID format keeps the port (DIDs accept colons), but the synthetic
      // address must match RFC-5321 host syntax — so a deployment served at
      // `localhost:8080` produces `slug@agents.localhost`, not
      // `slug@agents.localhost:8080`.
      JWTService.setTestConfig('localhost:8080');
      try {
        const response = await mint({
            provider: 'ollama',
            model: 'gemma2:27b',
      });

        const { token } = await response.json() as { token: string };
        const payload = JWTService.verifyToken(token as never);
        expect(payload.email).not.toContain(':');
        expect(payload.email.endsWith('@agents.localhost')).toBe(true);
      } finally {
        // Restored even on failure: leaking this domain fails every later test
        // in the file for a reason that names the wrong culprit.
        JWTService.setTestConfig(SITE_DOMAIN);
      }
    });

    it('URI-encodes models containing colons in the DID', async () => {

      const response = await mint({
          provider: 'ollama',
          model: 'gemma2:27b',
      });

      const { did } = await response.json() as { did: string };
      // Colon in `gemma2:27b` must be %3A so DID parsing isn't ambiguous
      expect(did).toBe('did:web:test.local:agents:ollama:gemma2%3A27b');
    });
  });

  describe('rejected requests', () => {
    const ASK = { provider: 'ollama', model: 'gemma2:27b' };

    it('returns 401 with no bearer at all', async () => {
      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ASK),
      });

      expect(response.status).toBe(401);
    });

    /**
     * The load-bearing case. A service account that exists in the realm but was
     * never granted the agent role must NOT be able to mint agent identities —
     * otherwise every client in the realm inherits what the shared secret used
     * to grant, and the change buys nothing.
     */
    it('returns 401 for a verifiable token without the agent role', async () => {
      const response = await mint(ASK, await issuer.token({ claims: { azp: 'semiont-browser' } }));

      expect(response.status).toBe(401);
      const data = await response.json() as ErrorResponse;
      expect(String(data.error)).toMatch(/semiont-service/);
    });

    it('returns 401 when the role claim is nested rather than flat', async () => {
      // Keycloak's own shape. The gateway reads a flat `roles` array so that an
      // operator on another issuer can map into it; accepting the nested form
      // too would put a vendor's layout in the verification path.
      const nested = await issuer.token({ claims: { realm_access: { roles: [SERVICE_ROLE] } } });

      expect((await mint(ASK, nested)).status).toBe(401);
    });

    it('returns 401 for a token signed by a key the issuer does not publish', async () => {
      const forged = await issuer.token({
        claims: { roles: [SERVICE_ROLE] },
        privateKey: await issuer.unpublishedKey(),
      });

      expect((await mint(ASK, forged)).status).toBe(401);
    });

    it('returns 401 for a token minted for another audience', async () => {
      const wrongAudience = await issuer.token({
        claims: { roles: [SERVICE_ROLE] },
        audience: 'https://example.github.io/some-other-kb',
      });

      expect((await mint(ASK, wrongAudience)).status).toBe(401);
    });

    it('returns 400 when `provider` is missing', async () => {
      const response = await mint({
          model: 'gemma2:27b',
      });

      expect(response.status).toBe(400);
      const data = await response.json() as ErrorResponse;
      expect(String(data.error)).toMatch(/provider/i);
    });

    it('returns 400 when `model` is missing', async () => {
      const response = await mint({
          provider: 'ollama',
      });

      expect(response.status).toBe(400);
      const data = await response.json() as ErrorResponse;
      expect(String(data.error)).toMatch(/model/i);
    });

    it('returns 400 for malformed JSON', async () => {
      const response = await app.request('/api/tokens/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await sidecarToken()}`,
        },
        body: 'not-json',
      });

      expect(response.status).toBe(400);
    });

  });
});
