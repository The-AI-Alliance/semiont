/**
 * KnowledgeBase — a connection to a Semiont knowledge system.
 *
 * The KB type itself is uniform. The transport-shape variation lives in
 * the nested `endpoint` field, which is a discriminated union:
 *
 *  - `endpoint.kind === 'http'`  — a remote gateway reached over HTTP+SSE.
 *                                  Carries `host`/`port`/`protocol`.
 *  - `endpoint.kind === 'local'` — a knowledge system reached through a
 *                                  transport with no wire. Carries an
 *                                  opaque `kbId` identifying the
 *                                  instance to the host process.
 *
 * Session lifecycle code (a `SemiontSession`, `SemiontBrowser`'s
 * activation) treats `KnowledgeBase` as uniform and never inspects
 * `endpoint`. Code that constructs transports or signs in at an issuer (the
 * `SessionFactory` passed to `SemiontBrowser`, `kbGatewayUrl` for HTTP URL
 * construction, the sign-in paths) inspects `endpoint.kind` and dispatches.
 *
 * Each KB has its own session, its own credentials (where applicable),
 * and its own JWT (HTTP only). The user is "authenticated against KB X" —
 * never globally authenticated.
 *
 * The shapes are the spec's (`KbTarget`, `NewKnowledgeBase`,
 * `KnowledgeBase`, `KbRead`, `KbEndpoint` and its two kinds, from
 * `@semiont/core`); what is here is made from them.
 */

import type { KbDescription, KbRead, KbTarget } from '@semiont/core';

export function kbRead(description: KbDescription, at: Date): KbRead {
  return {
    at: at.toISOString(),
    ...(description.gitBranch !== undefined ? { gitBranch: description.gitBranch } : {}),
  };
}

/**
 * Status of the locally-stored credential for a KB. Derived from the
 * presence and validity of the JWT in session storage.
 */
export type KbSessionStatus = 'authenticated' | 'expired' | 'signed-out';

/**
 * Construct a `KbTarget` for an HTTP-backed Semiont gateway without
 * spelling out the nested `endpoint` literal. Convenience for tests,
 * worker bootstraps, and one-off scripts.
 *
 * ```ts
 * const kb = httpKb({
 *   id: 'my-watcher',
 *   label: 'My Watcher',
 *   host: 'localhost',
 *   port: 4000,
 *   protocol: 'http',
 * });
 * ```
 *
 * Equivalent to:
 *
 * ```ts
 * const kb: KbTarget = {
 *   id, label,
 *   endpoint: { kind: 'http', host, port, protocol },
 * };
 * ```
 *
 * UI hosts that have a structured form (host / port / protocol pickers)
 * already construct the literal directly — they don't need this helper.
 * Local-endpoint KBs construct the literal directly too; the local
 * endpoint shape (`{ kind: 'local', kbId }`) is one line and doesn't
 * earn a helper.
 */
export function httpKb(opts: {
  id: string;
  label: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
}): KbTarget {
  const { id, label, host, port, protocol } = opts;
  return {
    id,
    label,
    endpoint: { kind: 'http', host, port, protocol },
  };
}
