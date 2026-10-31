/**
 * SessionSignals — UI-facing notification state that belongs to the host
 * surface, not to the session itself.
 *
 * `SemiontSession` is a headless per-gateway client + token + user
 * holder. It can run in any process: browser, worker, CLI, test. But
 * the session-expired / permission-denied *notifications* are inherently
 * a UI-host concern. Keeping those observables on `SemiontSession` would
 * mean workers and CLIs carry dead BehaviorSubjects that nothing ever
 * fires.
 *
 * `SessionSignals` owns the notification state and has no hard reference
 * to a session. A UI host (e.g. `SemiontBrowser`) constructs one alongside
 * every active session and wires:
 *
 *   - `session.onAuthFailed` → `signals.notifySessionEnded` so a session
 *     that ends surfaces as a notification
 *
 * UI consumers that need to render modal/banner state subscribe here;
 * consumers that need bus/HTTP access continue to subscribe to the session.
 *
 * Session auth-state cleanup (clearing token, clearing storage) is
 * the session's own responsibility inside `refresh()` — by the time
 * `notifySessionEnded` runs, the session has already torn down.
 * Signals only surfaces the notification.
 *
 * A notice says what happened, never a sentence: what a person reads is the
 * host's to write, in their language.
 */

import { BehaviorSubject } from 'rxjs';
import { watched, type StateUnit, type Watched } from '@semiont/core';

/**
 * Why a session ended: its issuer refused to renew its token (`expired`), or
 * the gateway refused a token its issuer had just issued (`refused`). The
 * vocabulary is specs/src/session/cases.json's `told`.
 */
export type SessionEndReason = 'expired' | 'refused';

/** A session ended, and why. */
export interface SessionEnded {
  reason: SessionEndReason;
}

/**
 * A request was refused for lack of permission. `detail` is the refusal's own
 * message, untranslated; null when there is none.
 */
export interface PermissionDenied {
  detail: string | null;
}

/**
 * What the registry entry claimed, and what answered.
 *
 * Both dids, because neither alone is actionable: the user has to recognise
 * which KB they registered and which one answers.
 */
export interface KbIdentityConflict {
  expectedDid: string;
  observedDid: string;
}

/**
 * Each signal is one value: null while nothing is raised, the notice while
 * something is. A second occurrence is a new emission, so an observer sees it
 * even when the notice is equal to the last. Each is handed out read-only:
 * only `notify*` and `acknowledge*` move it.
 */
export interface SessionSignals extends StateUnit {
  /** The session ended: it expired, or its credential was refused. */
  readonly sessionEnded$: Watched<SessionEnded | null>;
  /** A request was refused for lack of permission. */
  readonly permissionDenied$: Watched<PermissionDenied | null>;
  /** A different knowledge base is answering at the entry's address. */
  readonly kbIdentityConflict$: Watched<KbIdentityConflict | null>;
  notifySessionEnded(reason: SessionEndReason): void;
  notifyPermissionDenied(detail: string | null): void;
  notifyKbIdentityConflict(conflict: KbIdentityConflict): void;
  acknowledgeSessionEnded(): void;
  acknowledgePermissionDenied(): void;
  acknowledgeKbIdentityConflict(): void;
}

export function createSessionSignals(): SessionSignals {
  const sessionEnded$ = new BehaviorSubject<SessionEnded | null>(null);
  const permissionDenied$ = new BehaviorSubject<PermissionDenied | null>(null);
  const kbIdentityConflict$ = new BehaviorSubject<KbIdentityConflict | null>(null);
  let disposed = false;
  // A completed BehaviorSubject still takes a value from `next`, which its
  // `getValue` then gives: once disposed, a notice is what it was.
  const raise = <T>(signal: BehaviorSubject<T>, notice: T): void => {
    if (!disposed) signal.next(notice);
  };
  return {
    sessionEnded$: watched(sessionEnded$),
    permissionDenied$: watched(permissionDenied$),
    kbIdentityConflict$: watched(kbIdentityConflict$),
    notifySessionEnded: (reason) => raise(sessionEnded$, { reason }),
    notifyPermissionDenied: (detail) => raise(permissionDenied$, { detail }),
    notifyKbIdentityConflict: (conflict) => raise(kbIdentityConflict$, conflict),
    acknowledgeSessionEnded: () => raise(sessionEnded$, null),
    acknowledgePermissionDenied: () => raise(permissionDenied$, null),
    acknowledgeKbIdentityConflict: () => raise(kbIdentityConflict$, null),
    dispose() {
      disposed = true;
      sessionEnded$.complete();
      permissionDenied$.complete();
      kbIdentityConflict$.complete();
    },
  };
}
