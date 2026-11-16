import type { ResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';

/**
 * The URL for a resource's raw bytes — the one shape `GET /api/resources/:id`
 * accepts from a browser. Pair with `useMediaToken`, which mints (and keeps
 * refreshing) the token.
 *
 * Two things a hand-written `/api/resources/${id}` gets wrong, both of them
 * silent until the byte never arrives:
 *
 * - **It must carry `?token=`.** That route is the browser-facing alias of the
 *   pipe, and exists only as the auth affordance for `<img>`, PDF.js and
 *   `<a download>` — none of which can attach an Authorization header. Auth is
 *   bearer + `?token=` only, no cookie, so a bare URL 401s.
 * - **It must be absolute.** react-ui embeds into a host app with its own
 *   origin, so a relative path resolves against the HOST, not the backend.
 *
 * Returns `undefined` when either input is missing — no client, or a token
 * that has not landed yet. There is no partially-correct URL worth rendering;
 * callers show a not-yet-ready affordance instead of a known-bad link.
 */
export function mediaUrl(
  client: SemiontClient | null | undefined,
  id: ResourceId,
  token: string | undefined,
): string | undefined {
  if (!client || !token) return undefined;
  return `${client.baseUrl}/api/resources/${id}?token=${token}`;
}
