/**
 * SessionFactory — the injection point that lets `SemiontBrowser` stay
 * transport-agnostic.
 *
 * The browser knows how to manage the *lifecycle* of an active session
 * (track it in `activeSession$`, dispose on KB switch, serialize
 * overlapping activations) but does not know how to *construct* one —
 * because that's where transport choice lives. The construction step
 * is parameterized via this factory.
 *
 * The HTTP factory is provided by `createHttpSessionFactory`. A
 * future in-process variant from `@semiont/make-meaning` would expose
 * its own factory.
 */

import type { KnowledgeBase } from './knowledge-base';
import type { SessionSignals } from './session-signals';
import type { SessionStorage } from './session-storage';
import type { SemiontSession } from './semiont-session';
import type { SemiontSessionError } from './errors';

export interface SessionFactoryOptions {
  /** The KB the session is being constructed for. */
  kb: KnowledgeBase;
  /** Persistence adapter — same one the browser uses. */
  storage: SessionStorage;
  /** Modal-signal sink for auth-failed / permission-denied notifications. */
  signals: SessionSignals;
  /** Receives session-level errors (auth-failed, refresh-exhausted, ...). */
  onError: (err: SemiontSessionError) => void;
}

export type SessionFactory = (opts: SessionFactoryOptions) => SemiontSession;
