/**
 * SDK-AUTH-CORS Phase 6 — diagnosability (RED-first).
 *
 * A bare-IRI browser navigation to a protected resource (no Authorization
 * header) already 401s (Phase 3). Phase 6 makes that 401 *actionable*: the
 * body keeps the machine-readable `error: 'Unauthorized'` and ADDS a `hint`
 * naming the fix (send an `Authorization: Bearer` token; browser navigation is
 * unauthenticated). RED on `main` today (no `hint`), GREEN once Phase 6 lands.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// pdfjs (via the make-meaning mock's importOriginal) needs DOMMatrix at module
// load; stub it in the hoist phase so this file runs in isolation.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.DOMMatrix ??= class {};
  g.ImageData ??= class {};
  g.Path2D ??= class {};
});

import { makeMeaningMock } from '../helpers/make-meaning-mock';

vi.mock('@semiont/make-meaning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@semiont/make-meaning')>();
  return { ...actual, startMakeMeaning: vi.fn().mockResolvedValue(makeMeaningMock()) };
});

import { app } from '../../index';
import { JWTService } from '../../auth/jwt';

describe('SDK-AUTH-CORS Phase 6 — actionable 401 (diagnosability)', () => {
  beforeAll(() => {
    JWTService.initialize({
      site: { domain: 'test.local', oauthAllowedDomains: ['test.local', 'example.com'] },
    });
  });

  it('an unauthenticated bare-IRI GET /resources/:id returns 401 with an actionable Bearer hint', async () => {
    const res = await app.request('/resources/some-resource-id');

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string; hint?: string };
    // Machine-readable code preserved (additive)…
    expect(body.error).toBe('Unauthorized');
    // …plus a human-actionable hint naming the fix.
    expect(body.hint).toMatch(/Authorization: Bearer/i);
  });

  it('the hint is generic across protected routes (not resource-specific)', async () => {
    const res = await app.request('/api/users/me');

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string; hint?: string };
    expect(body.error).toBe('Unauthorized');
    expect(body.hint).toMatch(/Authorization: Bearer/i);
  });
});
