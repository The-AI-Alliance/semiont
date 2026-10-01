/**
 * SessionSignals — UI-facing notification state that belongs to the host
 * surface, not to the session itself.
 *
 * `SemiontSession` is a headless per-gateway client + token + user
 * holder. It can run in any process: browser, worker, CLI, test. But
 * the session-expired / permission-denied *notifications* are inherently
 * a UI-host concern. Keeping those observables on `SemiontSession` meant
 * workers and CLIs carried dead BehaviorSubjects that nothing would ever
 * fire.
 *
 * `SessionSignals` owns the notification state and has no hard reference
 * to a session. A UI host (e.g. `SemiontBrowser`) constructs one alongside
 * every active session and wires:
 *
 *   - `session.onAuthFailed` → `signals.notifySessionExpired` so
 *     proactive-refresh failures surface as a notification
 *
 * UI consumers that need to render modal/banner state subscribe here;
 * consumers that need bus/HTTP access continue to subscribe to the session.
 *
 * Session auth-state cleanup (clearing token, clearing storage) is
 * the session's own responsibility inside `refresh()` — by the time
 * `notifySessionExpired` runs, the session has already torn down.
 * Signals only surfaces the notification.
 */

import { BehaviorSubject } from 'rxjs';

/**
 * A notification raised with a message, for a modal to show until it is
 * acknowledged.
 */
export interface SessionNotice {
  message: string;
}

/**
 * What the registry entry claimed, and what answered.
 *
 * Both dids, because neither alone is actionable: the user has to recognise
 * which KB they registered and which one is there now.
 */
export interface KbIdentityConflict {
  expectedDid: string;
  observedDid: string;
}

/**
 * Each signal is ONE subject of one value: null while nothing is raised, the
 * notice while something is. A second occurrence is a new emission, so an
 * observer sees it even when the notice is equal to the last.
 */
export class SessionSignals {
  /** The session ended and could not be renewed. */
  readonly sessionExpired$: BehaviorSubject<SessionNotice | null>;
  /** A request was refused for lack of permission. */
  readonly permissionDenied$: BehaviorSubject<SessionNotice | null>;
  /**
   * The KB at this entry's address reported a did other than the one the
   * entry stores — a different knowledge base is answering
   * (KB-IDENTITY-CHECKED-ON-ACTIVATION). Carries both dids so the UI can name
   * what was expected and what answered.
   *
   * A signal, not a decision: the local state that claimed to be about the
   * old KB is already voided by the time this fires, and re-registering under
   * the new identity is a deliberate act the panel already has a flow for.
   */
  readonly kbIdentityConflict$: BehaviorSubject<KbIdentityConflict | null>;

  constructor() {
    this.sessionExpired$ = new BehaviorSubject<SessionNotice | null>(null);
    this.permissionDenied$ = new BehaviorSubject<SessionNotice | null>(null);
    this.kbIdentityConflict$ = new BehaviorSubject<KbIdentityConflict | null>(null);
  }

  notifySessionExpired(message: string | null): void {
    this.sessionExpired$.next({ message: message ?? 'Your session has expired. Please sign in again.' });
  }

  notifyPermissionDenied(message: string | null): void {
    this.permissionDenied$.next({ message: message ?? 'You do not have permission to perform this action.' });
  }

  notifyKbIdentityConflict(conflict: KbIdentityConflict): void {
    this.kbIdentityConflict$.next(conflict);
  }

  acknowledgeSessionExpired(): void {
    this.sessionExpired$.next(null);
  }

  acknowledgePermissionDenied(): void {
    this.permissionDenied$.next(null);
  }

  acknowledgeKbIdentityConflict(): void {
    this.kbIdentityConflict$.next(null);
  }

  dispose(): void {
    this.sessionExpired$.complete();
    this.permissionDenied$.complete();
    this.kbIdentityConflict$.complete();
  }
}
