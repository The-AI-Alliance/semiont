/**
 * HttpTransport — the HTTP/SSE implementation of ITransport.
 *
 * The remote half of a transport-agnostic client. Owns everything that
 * crosses the wire in remote mode: the bus actor (SSE + POST /bus/emit),
 * auth/admin/exchange/system HTTP endpoints, and connection-state plumbing.
 *
 * Does NOT own the local coordination bus — that lives on `SemiontClient`.
 * `bridgeInto(bus)` wires SSE-received events into the caller-supplied bus
 * once at construction.
 */

import ky, { HTTPError, NetworkError, TimeoutError, type KyInstance } from 'ky';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import type {
  AccessToken,
  BaseUrl,
  EventBus,
  EventMap,
  Logger,
  ResourceId,
  components,
} from '@semiont/core';
import {
  SemiontError,
  busLog,
  relayFrames,
} from '@semiont/core';
import { SpanKind, recordBusSent, withSpan } from '@semiont/observability';
import { createActorStateUnit, type ActorStateUnit } from './actor-state-unit';
import { APIError } from './api-error';
import type {
  ConnectionState,
  IGatewayOperations,
  ITransport,
  HealthCheckResponse,
  StatusResponse,
  UserResponse,
} from '@semiont/core';
import { BRIDGED_CHANNELS, HTTP_REQUEST_TIMEOUT_MS, RETRY_RULES, RESOURCE_SCOPED_CHANNELS, type RetryPolicy } from '@semiont/core';
import type { BusEnvelope, BusFrame } from '@semiont/core';

type ProtectedResourceMetadata = components['schemas']['ProtectedResourceMetadata'];

export type TokenRefresher = () => Promise<string | null>;

export interface HttpTransportConfig {
  baseUrl: BaseUrl;
  /** Observable token source; headers read the current value. */
  token$?: BehaviorSubject<AccessToken | null>;
  /** The deadline on one request that is neither the stream nor an emit. Absent, `HTTP_REQUEST_TIMEOUT_MS`. */
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
  loadLastEventIds?: () => ReadonlyMap<ResourceId, string> | null;
  saveLastEventId?: (scope: ResourceId, id: string) => void;
  /**
   * The global SSE channel set this transport subscribes. Absent means the
   * full `BRIDGED_CHANNELS` — a full client must receive every operation's
   * reply channel, or its `busRequest`s time out. A narrow-profile process
   * (the worker) passes exactly the reply channels for the operations it
   * awaits, and is sent no frame on any other global channel.
   * A `busRequest` on an operation whose replies are outside this set
   * fails fast with `bus.unsubscribed` (see `BusRequestPrimitive`).
   */
  channels?: readonly (keyof EventMap)[];
  /**
   * `reconnectMs`, `lazyRemoveMs`, `lingerMs`, `emitRetry` and
   * `seenEventIdsCount` of specs/src/client/timing.json, for a caller that
   * must not wait them out: a test, or the conformance driver. Absent, the
   * table's values stand.
   */
  reconnectMs?: number;
  lazyRemoveMs?: number;
  lingerMs?: number;
  emitRetry?: RetryPolicy;
  seenEventIdsCount?: number;
}

/**
 * The gateway's refusal of a request. `error.data` is its body: ky reads a
 * refused response before any hook runs, and nothing can be read from
 * `error.response` after it.
 */
function refusalOf(error: HTTPError): APIError {
  const { response, data } = error;
  return APIError.refusal(response.status, response.statusText, data, response.headers.get('retry-after'));
}

/**
 * A request the gateway never answered: the connection failed, or the
 * request's own deadline passed.
 */
function unansweredOf(request: Request, error: Error): APIError {
  return APIError.withoutResponse(`${request.method} ${new URL(request.url).pathname} got no answer: ${error.message}`, error.name);
}

/**
 * What a failed request is reported as: the gateway's refusal, or that it
 * never answered. Anything else — the caller's own abort, a fault in a
 * hook — is not the gateway's doing, and is handed back as it is.
 */
function reportedAs(request: Request, error: Error): Error {
  if (error instanceof HTTPError) return refusalOf(error);
  if (error instanceof NetworkError || error instanceof TimeoutError) return unansweredOf(request, error);
  return error;
}

const withoutTrailingSlash = (baseUrl: BaseUrl): BaseUrl =>
  (baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) as BaseUrl;

const CURRENT_USER = '/api/users/me';

/**
 * Ask the gateway at `baseUrl` who `token` is: one request, by a caller that
 * holds nothing else. There is no transport behind it, so no stream is
 * opened for it, and nothing renews the token: a refusal is the answer. A
 * session asks this of a credential it found stored, before it trusts it.
 */
export function currentUserOf(baseUrl: BaseUrl, token: AccessToken): Promise<UserResponse> {
  return ky.get(`${withoutTrailingSlash(baseUrl)}${CURRENT_USER}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: HTTP_REQUEST_TIMEOUT_MS,
    hooks: {
      beforeError: [
        async ({ request, error }) => {
          const reported = reportedAs(request, error);
          if (reported !== error) throw reported;
          return error;
        },
      ],
    },
  }).json();
}

export class HttpTransport implements ITransport, IGatewayOperations {
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
   * Per-resource subscription ref-counts. Distinct
   * resources COMPOSE — each key's first subscribe adds its scoped channels
   * to the actor's matrix, its last release removes them; keys are fully
   * independent. Local fan-out for scoped channels is a SINGLETON wired in
   * the actor getter (one delivery per event regardless of how many scopes
   * are held), so entries here are counts only.
   */
  private readonly scopeRefCounts = new Map<ResourceId, number>();

  /** Buses we've been asked to bridge wire events into. */
  private readonly bridges: EventBus[] = [];

  private readonly config: HttpTransportConfig;

  constructor(config: HttpTransportConfig) {
    const { baseUrl, timeout = HTTP_REQUEST_TIMEOUT_MS, retry = 2, logger, tokenRefresher } = config;
    this.config = config;

    this.baseUrl = withoutTrailingSlash(baseUrl);
    this.token$ = config.token$ ?? new BehaviorSubject<AccessToken | null>(null);
    this.logger = logger;

    // Retry policy: when a refresher is configured, a 401 earns one attempt
    // after refreshing the token — on ANY method, since the request was
    // rejected rather than processed. Otherwise use the plain `retry` number,
    // which leaves ky's own defaults in place (they never retry POST).
    //
    // **`methods`/`statusCodes` are a superset PRE-FILTER, not the decision.**
    // ky ANDs them independently, so they cannot express "the widened methods
    // apply to 401 only" — the widening that lets a POST reach a 401 retry
    // also admits POST/504. `shouldRetry` is the authoritative gate and
    // rejects what the lists over-admit; the hooks suite's census test pins
    // that the lists stay a superset of what `RETRY_RULES.transport` can
    // approve, so the two cannot drift apart.
    const retryConfig = tokenRefresher
      ? {
          limit: 1,
          methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'],
          statusCodes: [401, 408, 413, 429, 500, 502, 503, 504],
          // One rule, stated in core with its reasoning: 401 on any method,
          // every other status on idempotent methods only. A POST that got a
          // 502 may already have been processed, and one of them mints a
          // fresh resource id, so a repeat writes a second resource the
          // caller never learns about.
          //
          // Narrowing only — `false` or `undefined`, never `true`. A `true`
          // here would bypass ky's own remaining checks, including the one
          // that retries `413` only when the response carries a retry-timing
          // header. Deferring keeps that behavior exactly as it is.
          //
          // This is the gate rather than `beforeRetry` because ky awaits the
          // full backoff delay before running that hook: rejecting there
          // means sleeping ~300ms first, every time, to reach a decision
          // that never depended on waiting.
          shouldRetry: ({ error }: { error: Error }): false | undefined =>
            error instanceof HTTPError &&
            !RETRY_RULES.transport.retryable({
              status: error.response.status,
              method: error.request.method,
            })
              ? false
              : undefined,
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
              // Whether to retry is `shouldRetry`'s decision, above. This
              // hook runs only once a retry is already confirmed, and does
              // the one thing it is for: put a fresh credential on the
              // request before it goes out again.
              async ({ request, error }) => {
                if (!(error instanceof HTTPError) || error.response.status !== 401) {
                  return undefined;
                }

                // A 401 earns its retry only if a fresh credential arrives.
                // Without one, repeating the request just gets rejected
                // again, so the caller should have the 401 at once.
                //
                // Stop by RETHROWING, never with `ky.stop`: `stop` resolves
                // the caller's promise with `undefined`, after which the
                // `.json()` shortcut dereferences nothing and the caller
                // catches a TypeError instead of the auth failure. A
                // rethrown original keeps ky's request-error path, so
                // `beforeError` runs and callers see the `APIError`.
                let newToken: string | null;
                try {
                  newToken = await tokenRefresher();
                } catch {
                  throw error;
                }
                if (!newToken) throw error;
                request.headers.set('Authorization', `Bearer ${newToken}`);
                return undefined;
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
            const reported = reportedAs(request, error);
            if (reported === error) return error;
            if (this.logger && error instanceof HTTPError) {
              this.logger.error('HTTP Request Failed', {
                type: 'http_error',
                url: request.url,
                method: request.method,
                status: error.response.status,
                statusText: error.response.statusText,
                error: reported.message,
              });
            }
            // A refusal and a request that was never answered are both on
            // `errors$`, as the `APIError` the caller is also given.
            if (reported instanceof APIError) this.errorsSubject.next(reported);
            throw reported;
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
  // `actor` is public for the processes that attach to the ActorStateUnit
  // itself; other callers use emit/on/stream/state$.

  get actor(): ActorStateUnit {
    if (!this._actor) {
      const globalChannels = this.config.channels ?? BRIDGED_CHANNELS;
      this._actor = createActorStateUnit({
        baseUrl: this.baseUrl,
        token: () => this.token$.getValue() ?? '',
        channels: [...globalChannels],
        ...(this.config.loadLastEventIds ? { loadLastEventIds: this.config.loadLastEventIds } : {}),
        ...(this.config.saveLastEventId ? { saveLastEventId: this.config.saveLastEventId } : {}),
        ...(this.config.reconnectMs !== undefined ? { reconnectMs: this.config.reconnectMs } : {}),
        ...(this.config.lazyRemoveMs !== undefined ? { lazyRemoveMs: this.config.lazyRemoveMs } : {}),
        ...(this.config.lingerMs !== undefined ? { lingerMs: this.config.lingerMs } : {}),
        ...(this.config.emitRetry !== undefined ? { emitRetry: this.config.emitRetry } : {}),
        ...(this.config.seenEventIdsCount !== undefined ? { seenEventIdsCount: this.config.seenEventIdsCount } : {}),
        // The SAME hook the ky beforeRetry path uses — the SSE connect path
        // refreshes once before parking `unauthenticated`, and no second
        // refresh mechanism exists.
        ...(this.config.tokenRefresher ? { tokenRefresher: this.config.tokenRefresher } : {}),
      });
      // Refused connects surface on the transport's contract stream too —
      // an SSE subscribe IS an HTTP request, refused as an `APIError` like
      // any other.
      this._actor.errors$.subscribe((e) => this.errorsSubject.next(e));
      // One fan-in per channel, wired once for the actor's lifetime — the
      // globally-subscribed set AND the resource-scoped set (disjoint by the
      // bus-invariants guard). Scoped events only arrive for scopes in the
      // actor's matrix (gateway-authoritative filtering), so an always-on
      // scoped fan-in delivers nothing while no scope is held — and exactly
      // ONCE per event however many scopes are held (a bridge
      // subscription per scope would duplicate delivery N×).
      //
      // `relayFrames` owns the hop itself (envelope carried, scope not). The
      // sink fans out to `this.bridges`, which `bridgeInto` appends to after
      // this is wired, so it must be read per frame rather than captured.
      relayFrames(
        this._actor,
        {
          emit: (channel, payload, envelope) => {
            for (const bus of this.bridges) bus.emit(channel, payload, envelope);
          },
        },
        [...globalChannels, ...RESOURCE_SCOPED_CHANNELS],
        // `EventBus.emit` is synchronous, so this never fires; it is the
        // honest answer rather than an omission the relay has to guard against.
        (channel, error) => this.logger?.error('Bridge relay failed', { channel, error }),
      );
    }
    return this._actor;
  }

  // ── ITransport — bus primitives ───────────────────────────────────────

  async emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    envelope?: BusEnvelope,
  ): Promise<number | undefined> {
    busLog('EMIT', channel as string, payload, envelope?.scope, envelope?.correlationId);
    recordBusSent(channel as string, envelope?.scope);
    return withSpan(
      `bus.emit:${channel as string}`,
      async () => {
        try {
          return await this.actor.emit(channel, payload, envelope);
        } catch (error) {
          // A refused emit is a transport failure like any other, so it is
          // reported where the others are before its caller hears it.
          if (error instanceof SemiontError) this.pushError(error);
          throw error;
        }
      },
      {
        kind: SpanKind.PRODUCER,
        attrs: {
          'bus.channel': channel as string,
          ...(envelope?.scope ? { 'bus.scope': envelope.scope } : {}),
        },
      },
    );
  }

  on<K extends keyof EventMap>(
    channel: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const sub = this.actor.stream(channel).subscribe(handler);
    return () => sub.unsubscribe();
  }

  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.actor.stream(channel);
  }

  frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>> {
    return this.actor.frames(channel);
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
    const count = this.scopeRefCounts.get(resourceId) ?? 0;
    this.scopeRefCounts.set(resourceId, count + 1);
    if (count === 0) {
      this.actor.addChannels([...RESOURCE_SCOPED_CHANNELS], resourceId);
    }

    let called = false;
    return () => {
      if (called) return;
      called = true;
      const remaining = (this.scopeRefCounts.get(resourceId) ?? 0) - 1;
      if (remaining > 0) {
        this.scopeRefCounts.set(resourceId, remaining);
        return;
      }
      this.scopeRefCounts.delete(resourceId);
      this.actor.removeChannels([...RESOURCE_SCOPED_CHANNELS], resourceId);
    };
  }

  get state$(): Observable<ConnectionState> {
    return this.actor.state$;
  }

  /**
   * Correlated-reply retention, client side (see
   * `docs/protocol/TRANSPORT-HTTP.md`): `busRequest` registers its cid
   * here before emitting; the actor carries the tracked set as
   * `pendingReplies` on every subscribe body, so a reply published while
   * the connection was down replays from the server's retention buffer on
   * reconnect instead of being lost.
   */
  trackReply(correlationId: string): () => void {
    return this.actor.trackReply(correlationId);
  }

  /**
   * `busRequest`'s fail-fast probe (`BusRequestPrimitive.isSubscribed`):
   * whether the actor's global subscription set delivers `channel`. On a
   * full client (no `channels` config) every bridged reply channel is
   * subscribed and this never gates; on a narrowed transport it turns a
   * doomed request into an immediate `bus.unsubscribed` error.
   */
  isSubscribed(channel: keyof EventMap): boolean {
    return this.actor.isSubscribed(channel);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scopeRefCounts.clear();
    // The disposed actor is kept, and built first if nothing ever touched it:
    // a caller arriving later must find a closed bus. Dropping it would let
    // the getter build a fresh one that nothing would ever start, and a
    // request would wait out its whole timeout on a stream that cannot open.
    this.actor.dispose();
    this.errorsSubject.complete();
  }

  /**
   * Route a transport-level error onto `errors$`. Used by sibling adapters
   * (e.g. `HttpContentTransport`'s `XMLHttpRequest` upload) that don't go
   * through the `ky` `beforeError` hook and need to surface failures on the
   * same stream the rest of the transport publishes to.
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

  async getCurrentUser(): Promise<UserResponse> {
    return this.http.get(`${this.baseUrl}${CURRENT_USER}`, {
      headers: this.authHeaders(),
    }).json();
  }

  async getProtectedResourceMetadata(): Promise<ProtectedResourceMetadata> {
    return this.http.get(`${this.baseUrl}/.well-known/oauth-protected-resource`).json();
  }

  async getMediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    return this.http.post(`${this.baseUrl}/api/tokens/media`, {
      json: { resourceId },
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

  // ── Internal: ky accessor for the content transport ───────────────────

  /**
   * The configured `ky` instance. `HttpContentTransport` issues its content
   * requests through it, so they pass through the same hooks.
   */
  get rawHttp(): KyInstance {
    return this.http;
  }

  /**
   * The access token (synchronously read from the BehaviorSubject). Used by
   * the content transport, which sets its own `Authorization` header.
   */
  getToken(): AccessToken | undefined {
    return this.token$.getValue() ?? undefined;
  }
}

// Re-export for convenience
export type { ConnectionState } from '@semiont/core';
