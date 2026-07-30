/**
 * JWT secret rotation — the verify-time key ring (JWT-SECRET-ROTATION.md, Half B).
 *
 * `JWT_SECRET` is an ordered, comma-separated list: the FIRST value signs, EVERY
 * value verifies. A single value is the one-element case and behaves exactly as
 * it always has. That grace window is what lets a secret change re-mint live
 * sessions on their next refresh instead of invalidating every token at once.
 *
 * Deliberately its own file, NOT part of `jwt.test.ts`: that suite mocks
 * `jsonwebtoken` and `types/jwt-types`, and these cases need the real library —
 * the whole point is which signature a real verifier accepts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { JWTService, requireJwtSecret } from '../../auth/jwt';

// Distinct, valid (>= 32 char) secrets.
const S_NEW = 'new-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const S_OLD = 'old-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const S_FOREIGN = 'foreign-secret-cccccccccccccccccccccccc';

const PAYLOAD = {
  userId: 'clx0a1b2c3d4e5f6g7h8i9j0k',
  email: 'user@example.com',
  domain: 'example.com',
  provider: 'google',
  isAdmin: false,
  tokenVersion: 0,
};

function signWith(secret: string, overrides: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) {
  return jwt.sign({ ...PAYLOAD, ...overrides }, secret, { expiresIn: '10m', issuer: 'example.com', ...opts });
}

let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.JWT_SECRET;
  JWTService.setTestConfig('example.com', ['example.com']);
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
  JWTService.resetConfig();
});

describe('JWT_SECRET as an ordered key ring', () => {
  it('verifies a token signed under a PREVIOUS secret during the rotation window', () => {
    // The whole point: the token was minted before the rotation.
    const token = signWith(S_OLD);
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    const payload = JWTService.verifyToken(token);
    expect(payload.userId).toBe(PAYLOAD.userId);
    expect(payload.email).toBe(PAYLOAD.email);
  });

  it('signs with the FIRST secret only, so tokens re-mint under the new key', () => {
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    const minted = JWTService.generateToken(PAYLOAD as never, '10m');

    // Verifiable under the new secret alone...
    expect(() => jwt.verify(minted, S_NEW)).not.toThrow();
    // ...and NOT under the retired one: signing must never fall back down the ring.
    expect(() => jwt.verify(minted, S_OLD)).toThrow();
  });

  it('rejects a token signed with a secret that is not in the ring', () => {
    const token = signWith(S_FOREIGN);
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    expect(() => JWTService.verifyToken(token)).toThrow('Invalid token signature');
  });

  it('is unchanged for a single-value secret (the one-element case)', () => {
    const token = signWith(S_NEW);
    process.env.JWT_SECRET = S_NEW;

    expect(JWTService.verifyToken(token).userId).toBe(PAYLOAD.userId);
    expect(() => JWTService.verifyToken(signWith(S_FOREIGN))).toThrow('Invalid token signature');
  });

  it('tolerates whitespace around ring members', () => {
    const token = signWith(S_OLD);
    process.env.JWT_SECRET = `${S_NEW} , ${S_OLD}`;

    expect(JWTService.verifyToken(token).userId).toBe(PAYLOAD.userId);
  });

  it('validates EACH member of the ring, not the concatenated string', () => {
    // Joined length is > 32, so a whole-string check would wrongly pass this.
    process.env.JWT_SECRET = `${S_NEW},too-short`;

    expect(() => requireJwtSecret()).toThrow(/32 characters/);
  });

  it('still rejects an absent secret', () => {
    delete process.env.JWT_SECRET;
    expect(() => requireJwtSecret()).toThrow(/JWT_SECRET is not set/);
  });
});

describe('error precedence — the ring must not mask non-signature failures', () => {
  // `TokenExpiredError` and `NotBeforeError` both EXTEND `JsonWebTokenError`, so a
  // ring loop that treats "instanceof JsonWebTokenError" as "try the next secret"
  // would walk the whole ring for an expired token and then report it as a bad
  // signature. Expiry is a property of the token, not of which key verified it.
  it('reports an EXPIRED token as expired, not as an invalid signature', () => {
    const token = signWith(S_NEW, {}, { expiresIn: '-10s' });
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    expect(() => JWTService.verifyToken(token)).toThrow('Token has expired');
  });

  it('reports expiry even when the token was signed under a PREVIOUS secret', () => {
    const token = signWith(S_OLD, {}, { expiresIn: '-10s' });
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    expect(() => JWTService.verifyToken(token)).toThrow('Token has expired');
  });

  it('surfaces a payload-validation failure rather than a signature error', () => {
    // Correctly signed, but missing required claims (tokenVersion, domain, ...).
    const token = jwt.sign({ userId: PAYLOAD.userId }, S_NEW, { expiresIn: '10m' });
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    expect(() => JWTService.verifyToken(token)).toThrow(/Invalid token payload/);
  });
});

describe('media tokens ride the same ring', () => {
  it('verifies a media token signed under a previous secret', () => {
    const token = jwt.sign({ purpose: 'media', sub: 'res-abc', userId: 'u1' }, S_OLD, { expiresIn: '5m' });
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    expect(() => JWTService.verifyMediaToken(token, 'res-abc')).not.toThrow();
  });

  it('still rejects a media token signed outside the ring', () => {
    const token = jwt.sign({ purpose: 'media', sub: 'res-abc', userId: 'u1' }, S_FOREIGN, { expiresIn: '5m' });
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    expect(() => JWTService.verifyMediaToken(token, 'res-abc')).toThrow('Invalid media token');
  });

  it('still enforces resource scoping across the ring', () => {
    const token = jwt.sign({ purpose: 'media', sub: 'res-abc', userId: 'u1' }, S_OLD, { expiresIn: '5m' });
    process.env.JWT_SECRET = `${S_NEW},${S_OLD}`;

    expect(() => JWTService.verifyMediaToken(token, 'res-other')).toThrow('Media token resource mismatch');
  });
});
