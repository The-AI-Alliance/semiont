/**
 * SessionStore — observable store for authentication session state
 *
 * BehaviorSubject-backed store that computes session expiry from a JWT token.
 * Replaces useState in useSessionManager with a reactive store.
 */

import { BehaviorSubject, Observable } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import type { SessionState } from '@semiont/react-ui';

const EXPIRING_SOON_MS = 5 * 60 * 1000; // 5 minutes

function computeState(token: string | null): SessionState {
  if (!token) {
    return { isAuthenticated: false, expiresAt: null, timeUntilExpiry: null, isExpiringSoon: false };
  }

  let expiresAt: Date | null = null;
  try {
    const parts = token.split('.');
    if (parts.length === 3 && parts[1]) {
      const payload = JSON.parse(atob(parts[1])) as { exp?: number };
      if (payload.exp) expiresAt = new Date(payload.exp * 1000);
    }
  } catch {
    // Malformed JWT — treat as authenticated but no expiry info
  }

  const now = Date.now();
  const timeUntilExpiry = expiresAt ? expiresAt.getTime() - now : null;

  return {
    isAuthenticated: true,
    expiresAt,
    timeUntilExpiry,
    isExpiringSoon: timeUntilExpiry !== null && timeUntilExpiry < EXPIRING_SOON_MS && timeUntilExpiry > 0,
  };
}

export class SessionStore {
  private readonly state$ = new BehaviorSubject<SessionState>(computeState(null));

  /** Observable of the current session state */
  readonly session$: Observable<SessionState> = this.state$.asObservable();

  /** Update with a new token (call when auth state changes) */
  setToken(token: string | null): void {
    this.state$.next(computeState(token));
  }

  get state(): SessionState {
    return this.state$.value;
  }

  /** Observable of individual fields */
  select<K extends keyof SessionState>(key: K): Observable<SessionState[K]> {
    return this.session$.pipe(
      map(s => s[key]),
      distinctUntilChanged(),
    );
  }
}
