/**
 * SessionFactory — the injection point that lets `SemiontBrowser` stay
 * transport-agnostic.
 *
 * The browser knows how to manage the *lifecycle* of an active session
 * (track it in `activeSession$`, end it on KB switch, serialize
 * overlapping activations) but does not know how to *construct* one —
 * because that's where transport choice lives. The construction step
 * is parameterized via this factory.
 *
 * A factory builds a client and a session over it, and its caller owns
 * both: the session only uses its client, so whoever calls the factory
 * disposes `session.client` and then the session, so that what the client's
 * closing flush says reaches the session's errors before they end.
 *
 * A factory reads none of the session's errors: the registry that calls it
 * is their one reader, from the first thing the session said.
 *
 * The HTTP factory is provided by `createHttpSessionFactory`.
 */

import type { KnowledgeBase } from '@semiont/core';
import type { SessionSignals } from './session-signals';
import type { SessionStorage } from './session-storage';
import type { SemiontSession } from './semiont-session';

export interface SessionFactoryOptions {
  /** The KB the session is being constructed for. */
  kb: KnowledgeBase;
  /** Persistence adapter — same one the browser uses. */
  storage: SessionStorage;
  /** Modal-signal sink: the session's end is told here, and the registry says permission-denied here. */
  signals: SessionSignals;
}

export type SessionFactory = (opts: SessionFactoryOptions) => SemiontSession;
