/**
 * When the proactive refresh fires, derived from the token itself.
 *
 * The margin used to be a constant — `REFRESH_BEFORE_EXP_MS`, five minutes —
 * subtracted from `exp`. That was correct for as long as this client's tokens
 * came from a gateway minting hour-long ones. Moving identity to Keycloak
 * brought a realm whose `accessTokenLifespan` is also exactly five minutes, so
 * `exp - margin === iat`: a moment always in the past, a delay always `0`, and
 * a refresh that immediately scheduled another. Measured on an idle signed-in
 * page: 1418 successful `POST /token` in ten seconds.
 *
 * The margin is now a fraction of the token's OWN lifetime, so it cannot equal
 * the quantity it is subtracted from — no issuer's lifetime can reproduce the
 * loop, including issuers Semiont does not run and cannot configure.
 */

import { describe, it, expect } from 'vitest';
import {
  REFRESH_BEFORE_EXP_MS,
  MIN_REFRESH_DELAY_MS,
  refreshDelayMs,
} from '../storage';

const NOW = 1_800_000_000_000; // fixed, so these assert arithmetic not clocks

/** A token as an issuer mints it: issued now, living `lifetimeSec`. */
function token(lifetimeSec: number, opts: { iat?: boolean; ageSec?: number } = {}): string {
  const iat = Math.floor(NOW / 1000) - (opts.ageSec ?? 0);
  const payload: Record<string, number> = { exp: iat + lifetimeSec };
  if (opts.iat !== false) payload.iat = iat;
  const b64 = (o: unknown) => btoa(JSON.stringify(o));
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('refreshDelayMs — the margin is a fraction of the lifetime', () => {
  it('a 300s token — the exact collision — schedules a real delay, not zero', () => {
    // The regression, stated as arithmetic. Keycloak's default lifespan and
    // the old constant are both 300s, so the old rule produced exactly 0.
    const delay = refreshDelayMs(token(300), NOW);
    expect(delay).toBe(150_000);
  });

  it('no issuer lifetime can drive the delay to zero', () => {
    // The property, not an example: the margin is at most half the lifetime,
    // so a freshly minted token always has at least half of it left to wait.
    for (const lifetimeSec of [1, 5, 30, 60, 299, 300, 301, 600, 3600, 86_400]) {
      const delay = refreshDelayMs(token(lifetimeSec), NOW);
      expect(delay, `lifetime ${lifetimeSec}s`).not.toBeNull();
      expect(delay!, `lifetime ${lifetimeSec}s`).toBeGreaterThanOrEqual(MIN_REFRESH_DELAY_MS);
    }
  });

  it('refreshes BEFORE expiry for any lifetime the floor leaves room in', () => {
    // Above twice the floor, half-life is the binding rule and the refresh
    // lands inside the token's life, which is the point of refreshing early.
    for (const lifetimeSec of [30, 60, 299, 300, 301, 600, 3600, 86_400]) {
      expect(refreshDelayMs(token(lifetimeSec), NOW)!, `lifetime ${lifetimeSec}s`)
        .toBeLessThan(lifetimeSec * 1000);
    }
  });

  it('below twice the floor, the FLOOR wins and the refresh lands late — deliberately', () => {
    // A 1s access token cannot be refreshed ahead of its own expiry without
    // spinning, so it is refreshed late instead. The token is dead in the gap
    // and a 401 drives the reactive refresh; that is strictly better than a
    // timer firing continuously. Pinned so the trade is a decision, not a
    // surprise someone "fixes" by lowering the floor.
    expect(refreshDelayMs(token(1), NOW)).toBe(MIN_REFRESH_DELAY_MS);
    expect(refreshDelayMs(token(5), NOW)).toBe(MIN_REFRESH_DELAY_MS);
  });

  it('a long-lived token keeps the five-minute margin — the behaviour that was always right', () => {
    // An hour-long token: the constant is much smaller than half the lifetime,
    // so it still governs and the refresh lands 55 minutes out, exactly as it
    // did when the gateway minted these.
    expect(refreshDelayMs(token(3600), NOW)).toBe(3600_000 - REFRESH_BEFORE_EXP_MS);
  });

  it('a short-lived token refreshes at half-life, because the constant cannot apply', () => {
    expect(refreshDelayMs(token(60), NOW)).toBe(30_000);
  });
});

describe('refreshDelayMs — the floor', () => {
  it('a token already past its refresh point waits the floor, never zero', () => {
    // A session restored from storage with seconds left. One refresh is right;
    // a zero-delay timer that reschedules itself is the loop again.
    const delay = refreshDelayMs(token(300, { ageSec: 299 }), NOW);
    expect(delay).toBe(MIN_REFRESH_DELAY_MS);
  });

  it('an already-expired token still waits the floor rather than spinning', () => {
    expect(refreshDelayMs(token(300, { ageSec: 400 }), NOW)).toBe(MIN_REFRESH_DELAY_MS);
  });
});

describe('refreshDelayMs — what it does without a full claim set', () => {
  it('falls back to the REMAINING lifetime when the token carries no iat', () => {
    // Not every issuer sends `iat`. The remaining life is the only lifetime
    // observable then, and halving it is still bounded — which is the property
    // that matters. Here: 300s left, so 150s.
    expect(refreshDelayMs(token(300, { iat: false }), NOW)).toBe(150_000);
  });

  it('returns null when there is no exp to schedule against', () => {
    const b64 = (o: unknown) => btoa(JSON.stringify(o));
    expect(refreshDelayMs(`${b64({ alg: 'none' })}.${b64({ sub: 'u' })}.sig`, NOW)).toBeNull();
    expect(refreshDelayMs('not-a-jwt', NOW)).toBeNull();
  });
});

describe('the margin can never again reach the lifetime it is subtracted from', () => {
  it('gates the cross-package relationship the collision came from', () => {
    // `REFRESH_BEFORE_EXP_MS` (here) and the launcher's
    // `keycloakAccessTokenLifespan` (300s) are two hand-written numbers in
    // different packages that must relate, and nothing failed when they
    // stopped relating. This cannot import the launcher's — and for an
    // external issuer it is not ours at all — so the relationship is gated
    // where it can be: against the token, for every lifetime that matters.
    const REALM_LIFESPAN_SEC = 300;
    const delay = refreshDelayMs(token(REALM_LIFESPAN_SEC), NOW)!;

    // "A meaningful fraction of it" — not merely non-zero, which a one-second
    // floor would also satisfy while leaving the storm essentially intact.
    expect(delay).toBeGreaterThanOrEqual((REALM_LIFESPAN_SEC * 1000) / 4);
  });
});
