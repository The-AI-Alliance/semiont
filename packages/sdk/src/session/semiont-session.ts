/**
 * SemiontSession — per-backend session lifetime object. Owns the
 * SemiontClient, the access token BehaviorSubject, and optionally
 * an authenticated user. One SemiontSession exists per active backend
 * connection; lifetime is decoupled from React mount lifetime.
 *
 * Headless by design. Runs in browsers, CLIs, workers, and tests.
 * UI-specific state (session-expired/permission-denied modals) lives
 * in `FrontendSessionSignals`, which wraps a session — the session
 * itself has no modal observables, no user-facing notifications.
 *
 * Auth is parameterized via callbacks passed at construction:
 *
 *   - `refresh()` — invoked on 401 / proactive re-auth. Returns the
 *     new access token, or null on failure. The frontend passes a
 *     closure that runs the refresh-token flow; the worker passes
 *     one that exchanges the shared secret.
 *
 *   - `validate(token)` — optional. If provided, the session calls
 *     it once at startup with the stored token to confirm it's
 *     still good and populate `user$`. Frontend passes `getMe`;
 *     worker omits this (service principals have no user record).
 *
 *   - `onAuthFailed(message)` — optional. Invoked when refresh
 *     terminally fails (expired token, no recovery possible). The
 *     frontend wires this to `FrontendSessionSignals.notifySessionExpired`
 *     so the modal surfaces; headless consumers typically just log.
 *
 * Persistence goes through a `SessionStorage` adapter provided at
 * construction — the session never touches `localStorage` or `window`
 * directly.
 */

import { BehaviorSubject, type Observable } from 'rxjs';
import {
  accessToken,
  type AccessToken,
} from '@semiont/core';
import type { components, EventMap } from '@semiont/core';
import { SemiontClient, APIError } from '../client';
import type { ConnectionState } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';
import {
  clearStoredSession,
  getStoredSession,
  isJwtExpired,
  parseJwtExpiry,
  REFRESH_BEFORE_EXP_MS,
  sessionKey,
  type StoredSession,
} from './storage';
import { SemiontError } from './errors';
import type { SessionStorage } from './session-storage';

export type UserInfo = components['schemas']['UserResponse'];

export interface SemiontSessionConfig {
  kb: KnowledgeBase;
  /** Persistence adapter. Reads/writes tokens via this. */
  storage: SessionStorage;
  /**
   * Pre-built api client. The session does not construct it — caller
   * builds the transport stack and passes the client in. This is the
   * seam where consumers swap one `ITransport` implementation for
   * another (HTTP, in-process, etc.).
   */
  client: SemiontClient;
  /**
   * Token observable shared with the transport. Caller must pass the
   * SAME instance to both the transport (via `HttpTransport` config)
   * and the session. The session writes refreshed tokens here; the
   * transport reads from here.
   */
  token$: BehaviorSubject<AccessToken | null>;
  /**
   * Re-authenticate after expiry / 401. Returns a new access token
   * (no "Bearer " prefix) on success, or null if recovery is
   * impossible. Omit for transports where tokens don't apply.
   */
  refresh?: () => Promise<string | null>;
  /**
   * Validate the stored token at startup and populate `user$`. Omit
   * for service-principal sessions (worker, CLI tools) where there
   * is no user record to fetch.
   */
  validate?: (token: AccessToken) => Promise<UserInfo | null>;
  /**
   * Invoked when refresh terminally fails. Frontend consumers wire
   * this to a UI signal that surfaces the session-expired modal.
   */
  onAuthFailed?: (message: string | null) => void;
  /** Called for session-level failures (auth, refresh exhaustion). */
  onError?: (err: SemiontError) => void;
}

export class SemiontSession {
  readonly kb: KnowledgeBase;
  readonly client: SemiontClient;
  readonly token$: BehaviorSubject<AccessToken | null>;
  readonly user$: BehaviorSubject<UserInfo | null>;
  readonly streamState$: Observable<ConnectionState>;

  /** Resolves after the initial validation round-trip completes (success or failure). */
  readonly ready: Promise<void>;

  private readonly storage: SessionStorage;
  private readonly doRefresh?: () => Promise<string | null>;
  private readonly doValidate?: (token: AccessToken) => Promise<UserInfo | null>;
  private readonly onAuthFailed: (message: string | null) => void;
  private readonly onError: (err: SemiontError) => void;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private disposed = false;

  constructor(config: SemiontSessionConfig) {
    this.kb = config.kb;
    this.storage = config.storage;
    this.doRefresh = config.refresh;
    this.doValidate = config.validate;
    this.onAuthFailed = config.onAuthFailed ?? (() => {});
    this.onError = config.onError ?? (() => {});
    this.client = config.client;
    this.token$ = config.token$;
    this.user$ = new BehaviorSubject<UserInfo | null>(null);

    // Reconcile stored token: if there's a fresh stored access token
    // and `token$` hasn't been seeded yet, push the stored value so the
    // transport (which shares this token$) sees it on first auth.
    const stored = getStoredSession(this.storage, this.kb.id);
    if (stored && !isJwtExpired(stored.access) && this.token$.getValue() === null) {
      this.token$.next(accessToken(stored.access));
    }
    const initialToken = this.token$.getValue();

    this.streamState$ = this.client.state$;

    if (initialToken) {
      this.scheduleProactiveRefresh(initialToken);
    }

    this.unsubscribeStorage = this.storage.subscribe?.((key, newValue) => {
      this.handleStorageChange(key, newValue);
    }) ?? null;

    this.ready = this.validate(stored);
  }

  /**
   * Run the initial mount-time validation. If a stored access token is
   * present and unexpired, call the configured `validate` with it to
   * confirm it still works and populate `user$`. If expired, try
   * refresh first. On 401 from validate, try refresh once. Surfaces
   * auth-failed on terminal failure.
   *
   * When no `validate` callback is provided (service principals), this
   * still runs through the refresh-if-expired step so the stored
   * token is current — it just skips the user-validation round trip.
   */
  private async validate(stored: StoredSession | null): Promise<void> {
    if (!stored) return;

    const startToken = isJwtExpired(stored.access)
      ? (this.doRefresh ? await this.doRefresh() : null)
      : stored.access;
    if (!startToken) {
      if (isJwtExpired(stored.access)) {
        clearStoredSession(this.storage, this.kb.id);
      }
      return;
    }

    if (startToken !== stored.access) {
      this.token$.next(accessToken(startToken));
      this.scheduleProactiveRefresh(startToken);
    }

    // No validate callback => service-principal session. Token is
    // current; `user$` stays null. Done.
    if (!this.doValidate) return;

    const attempt = async (token: string): Promise<void> => {
      if (this.disposed) return;
      try {
        const data = await this.doValidate!(accessToken(token));
        if (this.disposed) return;
        this.user$.next(data);
      } catch (err) {
        if (this.disposed) return;
        if (err instanceof APIError && err.status === 401) {
          const refreshed = this.doRefresh ? await this.doRefresh() : null;
          if (this.disposed) return;
          if (refreshed) {
            this.token$.next(accessToken(refreshed));
            this.scheduleProactiveRefresh(refreshed);
            await attempt(refreshed);
            return;
          }
          clearStoredSession(this.storage, this.kb.id);
          this.token$.next(null);
          this.onAuthFailed('Your session has expired. Please sign in again.');
        } else {
          this.onError(
            new SemiontError(
              'session.auth-failed',
              err instanceof Error ? err.message : String(err),
              this.kb.id,
            ),
          );
        }
      }
    };

    await attempt(startToken);
  }

  /**
   * Refresh the access token via the configured `refresh` callback.
   * On success, pushes the new token into `token$` and schedules the
   * next proactive refresh. On failure, clears persisted state and
   * fires `onAuthFailed` — the frontend's wiring of that callback is
   * what surfaces the session-expired modal.
   */
  async refresh(): Promise<AccessToken | null> {
    if (this.disposed) return null;
    if (!this.doRefresh) return null;
    const newAccess = await this.doRefresh();
    if (this.disposed) return null;
    if (newAccess) {
      const tok = accessToken(newAccess);
      this.token$.next(tok);
      this.scheduleProactiveRefresh(newAccess);
      return tok;
    }
    this.token$.next(null);
    clearStoredSession(this.storage, this.kb.id);
    this.onAuthFailed('Your session has expired. Please sign in again.');
    this.onError(
      new SemiontError('session.refresh-exhausted', 'Token refresh failed', this.kb.id),
    );
    return null;
  }

  private scheduleProactiveRefresh(token: string): void {
    this.clearRefreshTimer();
    const expiresAt = parseJwtExpiry(token);
    if (!expiresAt) return;
    const refreshAt = expiresAt.getTime() - REFRESH_BEFORE_EXP_MS;
    const delay = Math.max(0, refreshAt - Date.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.disposed) void this.refresh();
    }, delay);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Cross-context sync: another tab/process refreshed or signed out this
   * KB. Mirror the change into our in-memory state.
   */
  private handleStorageChange(key: string, newValue: string | null): void {
    if (this.disposed) return;
    if (key !== sessionKey(this.kb.id)) return;
    if (!newValue) {
      this.token$.next(null);
      this.user$.next(null);
      this.clearRefreshTimer();
      return;
    }
    try {
      const parsed = JSON.parse(newValue) as StoredSession;
      if (typeof parsed.access === 'string') {
        this.token$.next(accessToken(parsed.access));
        this.scheduleProactiveRefresh(parsed.access);
      }
    } catch {
      // Malformed payload — ignore.
    }
  }

  get expiresAt(): Date | null {
    const token = this.token$.getValue();
    return token ? parseJwtExpiry(token) : null;
  }

  /**
   * Subscribe to a session-bus channel. The single sanctioned escape hatch
   * for generic-channel subscription (the case `useEventSubscription` needs
   * — channel name is a hook parameter, not known statically). All other
   * consumers must call typed namespace methods (e.g. `session.client.mark.archive(...)`).
   *
   * @returns disposer that unsubscribes the handler.
   */
  subscribe<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const sub = this.client.bus.get(channel).subscribe(handler);
    return () => sub.unsubscribe();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.clearRefreshTimer();
    if (this.unsubscribeStorage) {
      this.unsubscribeStorage();
      this.unsubscribeStorage = null;
    }

    this.client.dispose();

    this.token$.complete();
    this.user$.complete();
  }
}
