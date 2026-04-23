/**
 * FrontendSessionSignals — modal state that belongs to the UI, not
 * the session itself.
 *
 * `SemiontSession` is a headless per-backend client + token + user
 * holder. It can run in any process: browser, worker, CLI, test. But
 * the session-expired / permission-denied *modals* only make sense
 * in a UI context. Keeping those observables on `SemiontSession`
 * meant workers and CLIs carried four dead BehaviorSubjects that
 * nothing would ever fire.
 *
 * `FrontendSessionSignals` owns the modal state and has no hard
 * reference to a session. `SemiontBrowser` constructs one alongside
 * every frontend session and wires:
 *
 *   - `session.onAuthFailed` → `signals.notifySessionExpired` so
 *     proactive-refresh failures surface as modals
 *   - `notify` module handlers → the active signals' methods so
 *     external callers (e.g. React Query's QueryCache.onError) can
 *     trigger the modals without touching the session
 *
 * React consumers that need modal state subscribe here; consumers
 * that need bus/HTTP access continue to subscribe to the session.
 *
 * Session auth-state cleanup (clearing token, clearing storage) is
 * the session's own responsibility inside `refresh()` — by the time
 * `notifySessionExpired` runs, the session has already torn down.
 * Signals only surfaces the modal.
 */

import { BehaviorSubject } from 'rxjs';

export class FrontendSessionSignals {
  readonly sessionExpiredAt$: BehaviorSubject<number | null>;
  readonly sessionExpiredMessage$: BehaviorSubject<string | null>;
  readonly permissionDeniedAt$: BehaviorSubject<number | null>;
  readonly permissionDeniedMessage$: BehaviorSubject<string | null>;

  constructor() {
    this.sessionExpiredAt$ = new BehaviorSubject<number | null>(null);
    this.sessionExpiredMessage$ = new BehaviorSubject<string | null>(null);
    this.permissionDeniedAt$ = new BehaviorSubject<number | null>(null);
    this.permissionDeniedMessage$ = new BehaviorSubject<string | null>(null);
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

  acknowledgeSessionExpired(): void {
    this.sessionExpiredAt$.next(null);
    this.sessionExpiredMessage$.next(null);
  }

  acknowledgePermissionDenied(): void {
    this.permissionDeniedAt$.next(null);
    this.permissionDeniedMessage$.next(null);
  }

  dispose(): void {
    this.sessionExpiredAt$.complete();
    this.sessionExpiredMessage$.complete();
    this.permissionDeniedAt$.complete();
    this.permissionDeniedMessage$.complete();
  }
}
