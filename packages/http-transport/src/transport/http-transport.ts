/**
 * HttpTransport — the HTTP/SSE implementation of ITransport.
 *
 * Phase 1 of TRANSPORT-ABSTRACTION. Owns everything that crosses the wire
 * in remote mode: the bus actor (SSE + POST /bus/emit), auth/admin/exchange/
 * system HTTP endpoints, and connection-state plumbing.
 *
 * Does NOT own the local coordination bus — that lives on `SemiontClient`.
 * `bridgeInto(bus)` wires SSE-received events into the caller-supplied bus
 * once at construction.
 */

import ky, { HTTPError, type KyInstance } from 'ky';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import type {
  AccessToken,
  BaseUrl,
  Email,
  EventBus,
  EventMap,
  GoogleCredential,
  Logger,
  RefreshToken,
  ResourceId,
  UserDID,
  components,
} from '@semiont/core';
import {
  PERSISTED_EVENT_TYPES,
  RESOURCE_BROADCAST_TYPES,
  SemiontError,
  busLog,
} from '@semiont/core';
import type { TransportErrorCode } from '@semiont/core';
import { SpanKind, recordBusEmit, withSpan } from '@semiont/observability';
import { createActorStateUnit, type ActorStateUnit } from './actor-state-unit';
import type {
  ConnectionState,
  IBackendOperations,
  ITransport,
  HealthCheckResponse,
  StatusResponse,
  UserResponse,
  UpdateUserRequest,
  UpdateUserResponse,
  ListUsersResponse,
} from '@semiont/core';
import { BRIDGED_CHANNELS } from '@semiont/core';

type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];
type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];

// ── Channel constants (mirror client.ts) ────────────────────────────────

export const RESOURCE_SCOPED_CHANNELS = [
  // Exclude channels already globally bridged: a channel in both lists is
  // forwarded twice on a scoped connection (global copy → ephemeral id, scoped
  // copy → persisted id) with different SSE ids, escaping the client dedup
  // (.plans/bugs/BRIDGE-GAPS.md). Generalizes the former one-off
  // `frame:entity-type-added` exclusion.
  ...PERSISTED_EVENT_TYPES.filter((t) => !(BRIDGED_CHANNELS as readonly string[]).includes(t)),
  ...RESOURCE_BROADCAST_TYPES,
];

function classifyApiCode(status: number): TransportErrorCode {
  if (status === 400) return 'bad-request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'unavailable';
  return 'error';
}

export class APIError extends SemiontError {
  declare code: TransportErrorCode;
  readonly status: number;
  readonly statusText: string;

  constructor(message: string, status: number, statusText: string, body?: unknown) {
    super(message, classifyApiCode(status), { status, statusText, body });
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
  }
}

export type TokenRefresher = () => Promise<string | null>;

export interface HttpTransportConfig {
  baseUrl: BaseUrl;
  /** Observable token source; headers read the current value. */
  token$?: BehaviorSubject<AccessToken | null>;
  timeout?: number;
  retry?: number;
  logger?: Logger;
  /** Optional 401-recovery hook. See {@link TokenRefresher}. */
  tokenRefresher?: TokenRefresher;
  /**
   * B17 — persistence thunks for the last seen persisted SSE id PER
   * SCOPE, passed through to the actor state unit. See
   * {@link ActorStateUnitOptions}.
   */
  loadLastEventIds?: () => Record<string, string> | null;
  saveLastEventId?: (scope: string, id: string) => void;
}

export class HttpTransport implements ITransport, IBackendOperations {
  readonly baseUrl: BaseUrl;
  private readonly http: KyInstance;
  private readonly token$: BehaviorSubject<AccessToken | null>;
  private readonly logger?: Logger;
  private readonly errorsSubject: Subject<SemiontError> = new Subject<SemiontError>();
  /**
   * Stream of `APIError` instances surfaced from any HTTP request just
   * before the transport throws to the caller. Satisfies the `ITransport`
   * `errors$` contract — see `@semiont/core/transport.ts`.
   */
  readonly errors$: Observable<SemiontError> = this.errorsSubject.asObservable();

  private _actor: ActorStateUnit | null = null;
  private _actorStarted = false;
  private disposed = false;

  /**
   * Per-resource subscription ref-counts (MULTI-RESOURCE-SCOPE). Distinct
   * resources COMPOSE — each key's first subscribe adds its scoped channels
   * to the actor's matrix, its last release removes them; keys are fully
   * independent. Local fan-out for scoped channels is a SINGLETON wired in
   * the actor getter (one delivery per event regardless of how many scopes
   * are held), so entries here are counts only.
   */
  private readonly scopeRefCounts = new Map<string, number>();

  /** Buses we've been asked to bridge wire events into. */
  private readonly bridges: EventBus[] = [];

  private readonly config: HttpTransportConfig;

  constructor(config: HttpTransportConfig) {
    const { baseUrl, timeout = 30000, retry = 2, logger, tokenRefresher } = config;
    this.config = config;

    this.baseUrl = (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) as BaseUrl;
    this.token$ = config.token$ ?? new BehaviorSubject<AccessToken | null>(null);
    this.logger = logger;

    // Retry policy: when a refresher is configured, expand retry to also
    // cover 401 (one attempt). Otherwise use the plain `retry` number.
    const retryConfig = tokenRefresher
      ? {
          limit: 1,
          methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'],
          statusCodes: [401, 408, 413, 429, 500, 502, 503, 504],
        }
      : retry;

    this.http = ky.create({
      timeout,
      retry: retryConfig,
      hooks: {
        beforeRequest: [
          ({ request }) => {
            if (this.logger) {
              this.logger.debug('HTTP Request', {
                type: 'http_request',
                url: request.url,
                method: request.method,
                timestamp: Date.now(),
                hasAuth: request.headers.has('Authorization'),
              });
            }
          },
        ],
        beforeRetry: tokenRefresher
          ? [
              async ({ request, error }) => {
                if (!(error instanceof HTTPError) || error.response.status !== 401) {
                  return undefined;
                }
                try {
                  const newToken = await tokenRefresher();
                  if (!newToken) return ky.stop;
                  request.headers.set('Authorization', `Bearer ${newToken}`);
                  return undefined;
                } catch {
                  return ky.stop;
                }
              },
            ]
          : [],
        afterResponse: [
          ({ request, response }) => {
            if (this.logger) {
              this.logger.debug('HTTP Response', {
                type: 'http_response',
                url: request.url,
                method: request.method,
                status: response.status,
                statusText: response.statusText,
              });
            }
            return response;
          },
        ],
        beforeError: [
          async ({ request, error }) => {
            const response = error instanceof HTTPError ? error.response : undefined;
            if (response) {
              const body = await response.json().catch(() => ({})) as { message?: string };
              if (this.logger) {
                this.logger.error('HTTP Request Failed', {
                  type: 'http_error',
                  url: request.url,
                  method: request.method,
                  status: response.status,
                  statusText: response.statusText,
                  error: body.message || `HTTP ${response.status}: ${response.statusText}`,
                });
              }
              const apiError = new APIError(
                body.message || `HTTP ${response.status}: ${response.statusText}`,
                response.status,
                response.statusText,
                body,
              );
              this.errorsSubject.next(apiError);
              throw apiError;
            }
            return error;
          },
        ],
      },
    });

    // Auto-start the bus actor once a token arrives.
    this.token$.subscribe((token) => {
      if (token && !this._actorStarted && !this.disposed) {
        this._actorStarted = true;
        this.actor.start();
      }
    });
  }

  // ── Lazy actor construction + per-channel fan-in to bridges ───────────
  //
  // `actor` is exposed so the legacy `SemiontClient` can keep `.actor`
  // pointing at the same ActorStateUnit during the transport-abstraction
  // migration. Once SemiontClient is removed, this should be made
  // private again — external callers should use emit/on/stream/state$.

  get actor(): ActorStateUnit {
    if (!this._actor) {
      this._actor = createActorStateUnit({
        baseUrl: this.baseUrl,
        token: () => this.token$.getValue() ?? '',
        channels: [...BRIDGED_CHANNELS],
        ...(this.config.loadLastEventIds ? { loadLastEventIds: this.config.loadLastEventIds } : {}),
        ...(this.config.saveLastEventId ? { saveLastEventId: this.config.saveLastEventId } : {}),
      });
      // One fan-in per channel, wired once for the actor's lifetime — the
      // globally-bridged set AND the resource-scoped set (disjoint by the
      // bus-invariants guard). Scoped events only arrive for scopes in the
      // actor's matrix (backend-authoritative filtering), so an always-on
      // scoped fan-in delivers nothing while no scope is held — and exactly
      // ONCE per event however many scopes are held (the per-scope
      // bridge-subs design would have duplicated delivery N×).
      for (const channel of [...BRIDGED_CHANNELS, ...RESOURCE_SCOPED_CHANNELS]) {
        this._actor.on$<Record<string, unknown>>(channel).subscribe((payload) => {
          for (const bus of this.bridges) {
            (bus.get(channel as keyof EventMap) as { next(v: unknown): void }).next(payload);
          }
        });
      }
    }
    return this._actor;
  }

  // ── ITransport — bus primitives ───────────────────────────────────────

  async emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    resourceScope?: ResourceId,
  ): Promise<number> {
    busLog('EMIT', channel as string, payload, resourceScope as string | undefined);
    recordBusEmit(channel as string, resourceScope as string | undefined);
    return withSpan(
      `bus.emit:${channel as string}`,
      async () => {
        if (resourceScope !== undefined) {
          return this.actor.emit(
            channel as string,
            payload as unknown as Record<string, unknown>,
            resourceScope as string,
          );
        }
        return this.actor.emit(
          channel as string,
          payload as unknown as Record<string, unknown>,
        );
      },
      {
        kind: SpanKind.PRODUCER,
        attrs: {
          'bus.channel': channel as string,
          ...(resourceScope ? { 'bus.scope': resourceScope as string } : {}),
        },
      },
    );
  }

  on<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const sub = this.actor.on$<EventMap[K]>(channel as string).subscribe(handler);
    return () => sub.unsubscribe();
  }

  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.actor.on$<EventMap[K]>(channel as string);
  }

  /**
   * Wire this transport's SSE fan-in into the given bus. Every channel
   * in `BRIDGED_CHANNELS` (and subsequently per-resource scoped channels
   * opened by `subscribeToResource`) is published on the bus. Safe to
   * call multiple times — each bus is added to the fan-out list.
   */
  bridgeInto(bus: EventBus): void {
    this.bridges.push(bus);
  }

  subscribeToResource(resourceId: ResourceId): () => void {
    const key = resourceId as string;
    const count = this.scopeRefCounts.get(key) ?? 0;
    this.scopeRefCounts.set(key, count + 1);
    if (count === 0) {
      this.actor.addChannels([...RESOURCE_SCOPED_CHANNELS], key);
    }

    let called = false;
    return () => {
      if (called) return;
      called = true;
      const remaining = (this.scopeRefCounts.get(key) ?? 0) - 1;
      if (remaining > 0) {
        this.scopeRefCounts.set(key, remaining);
        return;
      }
      this.scopeRefCounts.delete(key);
      this.actor.removeChannels([...RESOURCE_SCOPED_CHANNELS], key);
    };
  }

  get state$(): Observable<ConnectionState> {
    return this.actor.state$;
  }

  /**
   * Correlated-reply retention, client side (BUS-RESUMPTION Phase 2 /
   * SDK-DEBT S1): `busRequest` registers its cid here before emitting;
   * the actor carries the tracked set as `pendingReplies` on every
   * subscribe body, so a reply published while the connection was down
   * replays from the server's retention buffer on reconnect.
   */
  trackReply(correlationId: string): () => void {
    return this.actor.trackReply(correlationId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scopeRefCounts.clear();
    if (this._actor) {
      this._actor.dispose();
      this._actor = null;
    }
    this.errorsSubject.complete();
  }

  /**
   * Route a transport-level error onto `errors$`. Used by sibling adapters
   * (e.g. `HttpContentTransport`'s XHR upload path) that don't go through
   * the `ky` `beforeError` hook and need to surface failures on the same
   * stream the rest of the transport publishes to.
   */
  pushError(error: SemiontError): void {
    if (this.disposed) return;
    this.errorsSubject.next(error);
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    const token = this.token$.getValue() ?? undefined;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async authenticatePassword(email: Email, password: string): Promise<AuthResponse> {
    return this.http.post(`${this.baseUrl}/api/tokens/password`, {
      json: { email, password },
      headers: this.authHeaders(),
    }).json();
  }

  async authenticateGoogle(credential: GoogleCredential): Promise<AuthResponse> {
    return this.http.post(`${this.baseUrl}/api/tokens/google`, {
      json: { credential },
      headers: this.authHeaders(),
    }).json();
  }

  async refreshAccessToken(token: RefreshToken): Promise<TokenRefreshResponse> {
    return this.http.post(`${this.baseUrl}/api/tokens/refresh`, {
      json: { refreshToken: token },
      headers: this.authHeaders(),
    }).json();
  }

  async logout(): Promise<void> {
    await this.http.post(`${this.baseUrl}/api/users/logout`, {
      headers: this.authHeaders(),
    }).json();
  }

  async acceptTerms(): Promise<void> {
    await this.http.post(`${this.baseUrl}/api/users/accept-terms`, {
      headers: this.authHeaders(),
    }).json();
  }

  async getCurrentUser(): Promise<UserResponse> {
    return this.http.get(`${this.baseUrl}/api/users/me`, {
      headers: this.authHeaders(),
    }).json();
  }

  async getMediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    return this.http.post(`${this.baseUrl}/api/tokens/media`, {
      json: { resourceId },
      headers: this.authHeaders(),
    }).json();
  }

  // ── Admin ─────────────────────────────────────────────────────────────

  async listUsers(): Promise<ListUsersResponse> {
    return this.http.get(`${this.baseUrl}/api/admin/users`, {
      headers: this.authHeaders(),
    }).json();
  }

  async getUserStats(): Promise<AdminUserStatsResponse> {
    return this.http.get(`${this.baseUrl}/api/admin/users/stats`, {
      headers: this.authHeaders(),
    }).json();
  }

  async updateUser(id: UserDID, data: UpdateUserRequest): Promise<UpdateUserResponse> {
    return this.http.patch(`${this.baseUrl}/api/admin/users/${id}`, {
      json: data,
      headers: this.authHeaders(),
    }).json();
  }

  async getOAuthConfig(): Promise<OAuthConfigResponse> {
    return this.http.get(`${this.baseUrl}/api/admin/oauth/config`, {
      headers: this.authHeaders(),
    }).json();
  }

  // ── System status ─────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResponse> {
    return this.http.get(`${this.baseUrl}/api/health`, {
      headers: this.authHeaders(),
    }).json();
  }

  async getStatus(): Promise<StatusResponse> {
    return this.http.get(`${this.baseUrl}/api/status`, {
      headers: this.authHeaders(),
    }).json();
  }

  // ── Internal: ky accessor for legacy passthroughs (temporary) ─────────

  /**
   * Temporary escape hatch for the ongoing transport migration: namespaces
   * that still need to issue ad-hoc HTTP calls (e.g. legacy browse/mark
   * HTTP fallbacks) can borrow the configured `ky` instance here. Will be
   * deleted once all namespaces route through bus channels or through
   * typed methods on this transport.
   */
  get rawHttp(): KyInstance {
    return this.http;
  }

  /**
   * Current access token (synchronously read from the BehaviorSubject).
   * Used by content-transport and legacy namespace HTTP fallbacks that
   * need to pass `auth: token` through some code paths.
   */
  getToken(): AccessToken | undefined {
    return this.token$.getValue() ?? undefined;
  }
}

// Re-export for convenience
export type { ConnectionState } from '@semiont/core';
