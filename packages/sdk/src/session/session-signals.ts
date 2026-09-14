/**
 * SessionSignals — UI-facing notification state that belongs to the host
 * surface, not to the session itself.
 *
 * `SemiontSession` is a headless per-gateway client + token + user
 * holder. It can run in any process: browser, worker, CLI, test. But
 * the session-expired / permission-denied *notifications* are inherently
 * a UI-host concern. Keeping those observables on `SemiontSession` meant
 * workers and CLIs carried four dead BehaviorSubjects that nothing would
 * ever fire.
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
 * What the registry entry claimed, and what answered.
 *
 * Both dids, because neither alone is actionable: the user has to recognise
 * which KB they registered and which one is there now.
 */
export interface KbIdentityConflict {
  expectedDid: string;
  observedDid: string;
}

export class SessionSignals {
  readonly sessionExpiredAt$: BehaviorSubject<number | null>;
  readonly sessionExpiredMessage$: BehaviorSubject<string | null>;
  readonly permissionDeniedAt$: BehaviorSubject<number | null>;
  readonly permissionDeniedMessage$: BehaviorSubject<string | null>;
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
  readonly kbIdentityConflictAt$: BehaviorSubject<number | null>;
  readonly kbIdentityConflict$: BehaviorSubject<KbIdentityConflict | null>;

  constructor() {
    this.sessionExpiredAt$ = new BehaviorSubject<number | null>(null);
    this.sessionExpiredMessage$ = new BehaviorSubject<string | null>(null);
    this.permissionDeniedAt$ = new BehaviorSubject<number | null>(null);
    this.permissionDeniedMessage$ = new BehaviorSubject<string | null>(null);
    this.kbIdentityConflictAt$ = new BehaviorSubject<number | null>(null);
    this.kbIdentityConflict$ = new BehaviorSubject<KbIdentityConflict | null>(null);
  }

  notifySessionExpired(message: string | null): void {
    this.sessionExpiredMessage$.next(
      message ?? 'Your session has expired. Please sign in again.',
    );
    this.sessionExpiredAt$.next(Date.now());
  }

  notifyPermissionDenied(message: string | null): void {
    this.permissionDeniedMessage$.next(
      message ?? 'You do not have permission to perform this action.',
    );
    this.permissionDeniedAt$.next(Date.now());
  }

  notifyKbIdentityConflict(conflict: KbIdentityConflict): void {
    this.kbIdentityConflict$.next(conflict);
    this.kbIdentityConflictAt$.next(Date.now());
  }

  acknowledgeSessionExpired(): void {
    this.sessionExpiredAt$.next(null);
    this.sessionExpiredMessage$.next(null);
  }

  acknowledgePermissionDenied(): void {
    this.permissionDeniedAt$.next(null);
    this.permissionDeniedMessage$.next(null);
  }

  acknowledgeKbIdentityConflict(): void {
    this.kbIdentityConflictAt$.next(null);
    this.kbIdentityConflict$.next(null);
  }

  dispose(): void {
    this.sessionExpiredAt$.complete();
    this.sessionExpiredMessage$.complete();
    this.permissionDeniedAt$.complete();
    this.permissionDeniedMessage$.complete();
    this.kbIdentityConflictAt$.complete();
    this.kbIdentityConflict$.complete();
  }
}
