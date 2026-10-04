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

/**
 * Why a session ended: its token could not be renewed (`expired`), or the
 * gateway refused a token its issuer had just issued (`refused`). The
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
  /** The session ended: it expired, or its credential was refused. */
  readonly sessionEnded$: BehaviorSubject<SessionEnded | null>;
  /** A request was refused for lack of permission. */
  readonly permissionDenied$: BehaviorSubject<PermissionDenied | null>;
  /**
   * The KB at this entry's address reported a did other than the one the
   * entry stores — a different knowledge base is answering. Checked when
   * the entry is activated. Carries both dids so the UI can name what was
   * expected and what answered.
   *
   * A signal, not a decision: the local state that claimed to be about the
   * old KB is already voided by the time this fires, and re-registering under
   * the new identity is a deliberate act the panel already has a flow for.
   */
  readonly kbIdentityConflict$: BehaviorSubject<KbIdentityConflict | null>;

  constructor() {
    this.sessionEnded$ = new BehaviorSubject<SessionEnded | null>(null);
    this.permissionDenied$ = new BehaviorSubject<PermissionDenied | null>(null);
    this.kbIdentityConflict$ = new BehaviorSubject<KbIdentityConflict | null>(null);
  }

  notifySessionEnded(reason: SessionEndReason): void {
    this.sessionEnded$.next({ reason });
  }

  notifyPermissionDenied(detail: string | null): void {
    this.permissionDenied$.next({ detail });
  }

  notifyKbIdentityConflict(conflict: KbIdentityConflict): void {
    this.kbIdentityConflict$.next(conflict);
  }

  acknowledgeSessionEnded(): void {
    this.sessionEnded$.next(null);
  }

  acknowledgePermissionDenied(): void {
    this.permissionDenied$.next(null);
  }

  acknowledgeKbIdentityConflict(): void {
    this.kbIdentityConflict$.next(null);
  }

  dispose(): void {
    this.sessionEnded$.complete();
    this.permissionDenied$.complete();
    this.kbIdentityConflict$.complete();
  }
}
