/**
 * SemiontSession — per-KB session lifetime object. Owns the SemiontApiClient,
 * the access token BehaviorSubject, and the authenticated user. One
 * SemiontSession exists per active KB; lifetime is decoupled from React
 * mount lifetime. Constructed via SemiontBrowser's registry, disposed via
 * SemiontBrowser.setActiveKb (or signOut).
 *
 * Persistence goes through a `SessionStorage` adapter provided at
 * construction — the session never touches `localStorage` or `window`
 * directly.
 *
 * The session's EventBus is owned by the client and re-exposed via
 * `session.emit` / `session.on`. React components subscribe via
 * `useEventSubscription[s]`. Nothing outside the session reaches for the
 * bus directly (see UNREACT.md D7).
 */

import { BehaviorSubject, type Observable } from 'rxjs';
import { SemiontApiClient, APIError, type ConnectionState } from '@semiont/api-client';
import {
  accessToken,
  baseUrl,
  EventBus,
  type AccessToken,
  type EventMap,
} from '@semiont/core';
import type { components } from '@semiont/core';
import type { KnowledgeBase } from '../types/knowledge-base';
import {
  clearStoredSession,
  getStoredSession,
  isJwtExpired,
  kbBackendUrl,
  parseJwtExpiry,
  REFRESH_BEFORE_EXP_MS,
  sessionKey,
  type StoredSession,
} from './storage';
import { performRefresh } from './refresh';
import { SemiontError } from './errors';
import type { SessionStorage } from './session-storage';

export type UserInfo = components['schemas']['UserResponse'];

export interface SemiontSessionConfig {
  kb: KnowledgeBase;
  /** Persistence adapter. Reads/writes tokens via this. */
  storage: SessionStorage;
  /** Called for session-level failures (auth, refresh exhaustion). */
  onError?: (err: SemiontError) => void;
}

export class SemiontSession {
  readonly kb: KnowledgeBase;
  readonly client: SemiontApiClient;
  readonly token$: BehaviorSubject<AccessToken | null>;
  readonly user$: BehaviorSubject<UserInfo | null>;
  readonly streamState$: Observable<ConnectionState>;

  readonly sessionExpiredAt$: BehaviorSubject<number | null>;
  readonly sessionExpiredMessage$: BehaviorSubject<string | null>;
  readonly permissionDeniedAt$: BehaviorSubject<number | null>;
  readonly permissionDeniedMessage$: BehaviorSubject<string | null>;

  /** Resolves after the initial validation round-trip completes (success or failure). */
  readonly ready: Promise<void>;

  private readonly storage: SessionStorage;
  private readonly eventBus: EventBus;
  private readonly onError: (err: SemiontError) => void;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private disposed = false;

  constructor(config: SemiontSessionConfig) {
    this.kb = config.kb;
    this.storage = config.storage;
    this.onError = config.onError ?? (() => {});

    const stored = getStoredSession(this.storage, this.kb.id);
    const initialToken =
      stored && !isJwtExpired(stored.access) ? accessToken(stored.access) : null;

    this.token$ = new BehaviorSubject<AccessToken | null>(initialToken);
    this.user$ = new BehaviorSubject<UserInfo | null>(null);
    this.sessionExpiredAt$ = new BehaviorSubject<number | null>(null);
    this.sessionExpiredMessage$ = new BehaviorSubject<string | null>(null);
    this.permissionDeniedAt$ = new BehaviorSubject<number | null>(null);
    this.permissionDeniedMessage$ = new BehaviorSubject<string | null>(null);

    this.client = new SemiontApiClient({
      baseUrl: baseUrl(kbBackendUrl(this.kb)),
      token$: this.token$,
      tokenRefresher: () => this.refresh().then((t) => t ?? null),
    });
    // The client now owns its EventBus; the session re-exposes it
    // internally for emit/on routing.
    this.eventBus = this.client.eventBus;

    this.streamState$ = this.client.actor.state$;

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
   * present and unexpired, call getMe with it; if expired, try refresh
   * first. On 401, try refresh once. Populates user$ on success; surfaces
   * the session-expired modal on terminal failure.
   */
  private async validate(stored: StoredSession | null): Promise<void> {
    if (!stored) return;

    const startToken = isJwtExpired(stored.access)
      ? await performRefresh(this.kb, this.storage)
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

    const attempt = async (token: string): Promise<void> => {
      if (this.disposed) return;
      const throwaway = new SemiontApiClient({
        baseUrl: baseUrl(kbBackendUrl(this.kb)),
      });
      try {
        const data = await throwaway.getMe({ auth: accessToken(token) });
        if (this.disposed) return;
        this.user$.next(data as UserInfo);
      } catch (err) {
        if (this.disposed) return;
        if (err instanceof APIError && err.status === 401) {
          const refreshed = await performRefresh(this.kb, this.storage);
          if (this.disposed) return;
          if (refreshed) {
            this.token$.next(accessToken(refreshed));
            this.scheduleProactiveRefresh(refreshed);
            await attempt(refreshed);
            return;
          }
          clearStoredSession(this.storage, this.kb.id);
          this.token$.next(null);
          this.notifySessionExpired('Your session has expired. Please sign in again.');
        } else {
          this.onError(
            new SemiontError(
              'session.auth-failed',
              err instanceof Error ? err.message : String(err),
              this.kb.id,
            ),
          );
        }
      } finally {
        throwaway.dispose();
      }
    };

    await attempt(startToken);
  }

  /**
   * Refresh the access token. Dedupes concurrent calls via the module-scoped
   * in-flight Promise map in `performRefresh`. On success, pushes the new
   * token into `token$`. On failure, surfaces the session-expired modal and
   * emits a `session.refresh-exhausted` error.
   */
  async refresh(): Promise<AccessToken | null> {
    if (this.disposed) return null;
    const newAccess = await performRefresh(this.kb, this.storage);
    if (this.disposed) return null;
    if (newAccess) {
      const tok = accessToken(newAccess);
      this.token$.next(tok);
      this.scheduleProactiveRefresh(newAccess);
      return tok;
    }
    this.token$.next(null);
    clearStoredSession(this.storage, this.kb.id);
    this.notifySessionExpired('Your session has expired. Please sign in again.');
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

  /**
   * Emit an event onto the session's internal bus. The ONE gated entry
   * for every component emission (D7). Kept here rather than on
   * `client.eventBus` (which is not exposed publicly) so the session
   * can log, validate, scope-guard, or add metrics in one place.
   */
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
    if (this.disposed) return;
    (this.eventBus.get(channel) as unknown as { next(v: EventMap[K]): void }).next(payload);
  }

  /**
   * Subscribe to an event on the session's internal bus. Returns an
   * unsubscribe callback. Paired with `useEventSubscription` on the
   * React side — direct callers are the session's internals and tests.
   */
  on<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const sub = (this.eventBus.get(channel) as unknown as { subscribe(h: (v: EventMap[K]) => void): { unsubscribe(): void } }).subscribe(handler);
    return () => sub.unsubscribe();
  }

  notifySessionExpired(message: string | null): void {
    if (this.disposed) return;
    this.sessionExpiredMessage$.next(
      message ?? 'Your session has expired. Please sign in again.',
    );
    this.sessionExpiredAt$.next(Date.now());
    this.token$.next(null);
    this.user$.next(null);
    clearStoredSession(this.storage, this.kb.id);
    this.clearRefreshTimer();
  }

  notifyPermissionDenied(message: string | null): void {
    if (this.disposed) return;
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

  get expiresAt(): Date | null {
    const token = this.token$.getValue();
    return token ? parseJwtExpiry(token) : null;
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
    this.sessionExpiredAt$.complete();
    this.sessionExpiredMessage$.complete();
    this.permissionDeniedAt$.complete();
    this.permissionDeniedMessage$.complete();
  }
}
