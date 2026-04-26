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
import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
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
  busLog,
} from '@semiont/core';
import { createActorVM, type ActorVM } from './actor-vm';
import type {
  ConnectionState,
  ITransport,
  HealthCheckResponse,
  StatusResponse,
  UserResponse,
  UpdateUserRequest,
  UpdateUserResponse,
  ListUsersResponse,
  ProgressCallback,
  ProgressEvent,
} from '@semiont/core';
import { BRIDGED_CHANNELS } from '@semiont/core';

type AuthResponse = components['schemas']['AuthResponse'];
type TokenRefreshResponse = components['schemas']['TokenRefreshResponse'];
type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];

// ── Channel constants (mirror client.ts) ────────────────────────────────

const RESOURCE_SCOPED_CHANNELS = [
  ...PERSISTED_EVENT_TYPES.filter((t) => t !== 'mark:entity-type-added'),
  ...RESOURCE_BROADCAST_TYPES,
];

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'APIError';
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
}

export class HttpTransport implements ITransport {
  readonly baseUrl: BaseUrl;
  private readonly http: KyInstance;
  private readonly token$: BehaviorSubject<AccessToken | null>;
  private readonly logger?: Logger;

  private _actor: ActorVM | null = null;
  private _actorStarted = false;
  private disposed = false;

  private activeResource: {
    resourceId: ResourceId;
    refCount: number;
    bridgeSubs: Subscription[];
  } | null = null;

  /** Buses we've been asked to bridge wire events into. */
  private readonly bridges: EventBus[] = [];

  constructor(config: HttpTransportConfig) {
    const { baseUrl, timeout = 30000, retry = 2, logger, tokenRefresher } = config;

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
      credentials: 'include',
      hooks: {
        beforeRequest: [
          (request) => {
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
          (request, _options, response) => {
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
          async (error) => {
            const { response, request } = error;
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
              throw new APIError(
                body.message || `HTTP ${response.status}: ${response.statusText}`,
                response.status,
                response.statusText,
                body,
              );
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
  // pointing at the same ActorVM during the transport-abstraction
  // migration. Once SemiontClient is removed, this should be made
  // private again — external callers should use emit/on/stream/state$.

  get actor(): ActorVM {
    if (!this._actor) {
      this._actor = createActorVM({
        baseUrl: this.baseUrl,
        token: () => this.token$.getValue() ?? '',
        channels: [...BRIDGED_CHANNELS],
      });
      for (const channel of BRIDGED_CHANNELS) {
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
  ): Promise<void> {
    busLog('EMIT', channel as string, payload, resourceScope as string | undefined);
    if (resourceScope !== undefined) {
      await this.actor.emit(
        channel as string,
        payload as unknown as Record<string, unknown>,
        resourceScope as string,
      );
    } else {
      await this.actor.emit(
        channel as string,
        payload as unknown as Record<string, unknown>,
      );
    }
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
    if (this.activeResource) {
      if (this.activeResource.resourceId !== resourceId) {
        throw new Error(
          `HttpTransport already subscribed to resource ${this.activeResource.resourceId}; ` +
            `call the unsubscribe returned from the previous subscribeToResource before subscribing to ${resourceId}.`,
        );
      }
      this.activeResource.refCount++;
      return this.makeUnsubscriber();
    }

    this.actor.addChannels([...RESOURCE_SCOPED_CHANNELS], resourceId as string);

    const bridgeSubs: Subscription[] = [];
    for (const channel of RESOURCE_SCOPED_CHANNELS) {
      bridgeSubs.push(
        this.actor.on$<Record<string, unknown>>(channel).subscribe((payload) => {
          for (const bus of this.bridges) {
            (bus.get(channel as keyof EventMap) as { next(v: unknown): void }).next(payload);
          }
        }),
      );
    }

    this.activeResource = { resourceId, refCount: 1, bridgeSubs };
    return this.makeUnsubscriber();
  }

  private makeUnsubscriber(): () => void {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      if (!this.activeResource) return;
      this.activeResource.refCount--;
      if (this.activeResource.refCount > 0) return;
      for (const sub of this.activeResource.bridgeSubs) sub.unsubscribe();
      this.actor.removeChannels([...RESOURCE_SCOPED_CHANNELS]);
      this.activeResource = null;
    };
  }

  get state$(): Observable<ConnectionState> {
    return this.actor.state$;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeResource) {
      for (const sub of this.activeResource.bridgeSubs) sub.unsubscribe();
      this.activeResource = null;
    }
    if (this._actor) {
      this._actor.dispose();
      this._actor = null;
    }
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

  async generateMcpToken(): Promise<{ token: string }> {
    return this.http.post(`${this.baseUrl}/api/tokens/mcp-generate`, {
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

  // ── Exchange (backup/restore/export/import) ───────────────────────────

  async backupKnowledgeBase(): Promise<Response> {
    return this.http.post(`${this.baseUrl}/api/admin/exchange/backup`, {
      headers: this.authHeaders(),
    });
  }

  async restoreKnowledgeBase(
    file: File,
    onProgress?: ProgressCallback,
  ): Promise<ProgressEvent> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.http.post(`${this.baseUrl}/api/admin/exchange/restore`, {
      body: formData,
      headers: this.authHeaders(),
    });
    return this.parseSSEStream(response, onProgress);
  }

  async exportKnowledgeBase(params?: { includeArchived?: boolean }): Promise<Response> {
    const searchParams = params?.includeArchived ? new URLSearchParams({ includeArchived: 'true' }) : undefined;
    return this.http.post(`${this.baseUrl}/api/moderate/exchange/export`, {
      headers: this.authHeaders(),
      ...(searchParams ? { searchParams } : {}),
    });
  }

  async importKnowledgeBase(
    file: File,
    onProgress?: ProgressCallback,
  ): Promise<ProgressEvent> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.http.post(`${this.baseUrl}/api/moderate/exchange/import`, {
      body: formData,
      headers: this.authHeaders(),
    });
    return this.parseSSEStream(response, onProgress);
  }

  private async parseSSEStream(
    response: Response,
    onProgress?: ProgressCallback,
  ): Promise<ProgressEvent> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: ProgressEvent = { phase: 'unknown' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));
          onProgress?.(event);
          if (event.phase === 'complete' || event.phase === 'error' || event.phase === 'failed') {
            finalResult = event;
          }
        }
      }
    }

    return finalResult;
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
