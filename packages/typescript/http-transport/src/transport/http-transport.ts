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

import ky, { HTTPError, NetworkError, TimeoutError, type AfterResponseState, type KyInstance, type RetryOptions } from 'ky';
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
import { createActorStateUnit, renewedToken, type ActorStateUnit } from './actor-state-unit';
import { APIError, refusalBody, refusesCredential } from './api-error';
import type {
  ConnectionState,
  IGatewayOperations,
  ITransport,
  HealthCheckResponse,
  StatusResponse,
  UserResponse,
} from '@semiont/core';
import { asDeclared, BRIDGED_CHANNELS, HTTP_REQUEST_TIMEOUT_MS, REQUEST_RETRY_PAUSE_MS, RETRY_RULES, RESOURCE_SCOPED_CHANNELS, watched, type RetryPolicy, type Watched } from '@semiont/core';
import type { BusEnvelope, BusFrame } from '@semiont/core';

type ProtectedResourceMetadata = components['schemas']['ProtectedResourceMetadata'];

export type TokenRefresher = () => Promise<string | null>;

export interface HttpTransportConfig {
  baseUrl: BaseUrl;
  /** The token, read and never written here: headers read its current value. */
  token$?: Watched<AccessToken | null>;
  /** The deadline on one request that is neither the stream nor an emit. Absent, `HTTP_REQUEST_TIMEOUT_MS`. */
  timeout?: number;
  logger?: Logger;
  /**
   * Renews a refused credential (a 401, or a 429 `refusal-rate`): asked once
   * for a request, an emit, or an outage of the stream, which is then sent
   * again with the token it gives. Absent, a refused credential is final.
   */
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
   * reply channel, or its `Bus.request`s time out. A narrow-profile process
   * (the worker) passes exactly the reply channels for the operations it
   * awaits, and is sent no frame on any other global channel.
   * A `Bus.request` on an operation whose replies are outside this set
   * fails fast with `bus.unsubscribed` (see `BusPrimitive`).
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
 * Ask ky for a request of `method` at `path`, and hand back what it answers.
 *
 * ky makes its request before any hook of its own runs, and the runtime
 * refuses to make one of a token that is no header value, or of an address
 * that is no URL or carries a credential. ky rejects with the refusal as the
 * runtime made it, a `TypeError`, the way `fetch` reports one. So a
 * `TypeError` is a request that was never made, which got no answer
 * (`APIError.unanswered`): ky's own errors are none, and by then its hooks
 * have made each of them the error the caller is given. `unanswered` is told
 * of it before it is thrown. Anything else is handed back as it is.
 */
async function asked<T>(method: string, path: string, ask: () => PromiseLike<T>, unanswered?: (failure: APIError) => void): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const failure = APIError.unanswered(`${method} ${path}`, error);
    unanswered?.(failure);
    throw failure;
  }
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

/** Whether ky's refused request had its credential refused: ky has read the body by the time it asks. */
const refusedCredential = (error: Error): boolean =>
  error instanceof HTTPError && refusesCredential(error.response.status, error.data);

/**
 * How every request is made a second time, whether or not anything renews
 * its token: once, after `REQUEST_RETRY_PAUSE_MS`, for the statuses and
 * methods `RETRY_RULES.transport` approves, or when it got no answer at all
 * on a method that cannot cause a second effect. Where a refresher is
 * configured, the renewal in the transport's `afterResponse` hook spends the
 * same one attempt. A refused credential is never retried: it is renewed, or
 * final.
 *
 * **`statusCodes` is a superset PRE-FILTER, not the decision**, and ky's
 * default `methods` are the idempotent ones. `shouldRetry` is the
 * authoritative gate and rejects what the lists over-admit; the hooks
 * suite's census test pins that `statusCodes` stays a superset of what
 * `RETRY_RULES.transport` can approve, so the two cannot drift apart.
 */
const RETRY: RetryOptions = {
  limit: 1,
  statusCodes: [408, 413, 429, 500, 502, 503, 504],
  delay: () => REQUEST_RETRY_PAUSE_MS,
  // A refused credential first: it is never asked of the rule, which would
  // retry a 429 `refusal-rate` after its `Retry-After` with the token
  // refused. Then one rule, stated in core with its reasoning: every other
  // status on idempotent methods only. A POST that got a 502 may already
  // have been processed, and one of them mints a fresh resource id, so a
  // repeat writes a second resource the caller never learns about.
  //
  // Narrowing only — `false` or `undefined`, never `true`. A `true` here
  // would bypass ky's own remaining checks, including the one that retries
  // `413` only when the response carries a retry-timing header. Deferring
  // keeps that behavior exactly as it is.
  shouldRetry: ({ error }: { error: Error }): false | undefined =>
    refusedCredential(error) ||
    (error instanceof HTTPError &&
      !RETRY_RULES.transport.retryable({
        status: error.response.status,
        method: error.request.method,
      }))
      ? false
      : undefined,
};

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
  return asked('GET', CURRENT_USER, () =>
    ky.get(`${withoutTrailingSlash(baseUrl)}${CURRENT_USER}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: HTTP_REQUEST_TIMEOUT_MS,
      retry: RETRY,
      hooks: {
        beforeError: [
          async ({ request, error }) => {
            const reported = reportedAs(request, error);
            if (reported !== error) throw reported;
            return error;
          },
        ],
      },
    }).json<UserResponse>());
}

export class HttpTransport implements ITransport, IGatewayOperations {
  readonly baseUrl: BaseUrl;
  private readonly http: KyInstance;
  private readonly token$: Watched<AccessToken | null>;
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
    const { baseUrl, timeout = HTTP_REQUEST_TIMEOUT_MS, logger, tokenRefresher } = config;
    this.config = config;

    this.baseUrl = withoutTrailingSlash(baseUrl);
    this.token$ = config.token$ ?? watched(new BehaviorSubject<AccessToken | null>(null));
    this.logger = logger;

    this.http = ky.create({
      timeout,
      retry: RETRY,
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
          ...(tokenRefresher
            ? [
                // A refused credential is renewed, never retried
                // (docs/protocol/TRANSPORT-CONTRACT.md § A refused credential):
                // the refresher is asked once, and the request sent again at
                // once with the token it gives. ky's forced retry is what sends
                // it: it neither waits out a `Retry-After` nor asks
                // `shouldRetry`. Given no token, or the one refused, the
                // refusal goes on to `beforeError` as `unauthorized`. So does a
                // refusal of the renewed token: the forced retry spent the one
                // attempt `limit` allows, so nothing sends it a third time.
                async ({ request, response, retryCount }: AfterResponseState) => {
                  if (response.ok || retryCount > 0) return undefined;
                  let said = '';
                  try {
                    said = await response.text();
                  } catch {
                    // status alone
                  }
                  if (!refusesCredential(response.status, refusalBody(said))) return undefined;
                  const sent = request.headers.get('Authorization');
                  const renewed = await this.renewal(sent === null ? undefined : sent.replace(/^Bearer /, ''));
                  if (renewed === null) return undefined;
                  try {
                    request.headers.set('Authorization', `Bearer ${renewed}`);
                  } catch {
                    // A token the runtime will not carry is no renewal either,
                    // and the runtime says the token in refusing it.
                    return undefined;
                  }
                  return ky.retry({ delay: 0, code: 'credential-renewed' });
                },
              ]
            : []),
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
  // The stream's machinery, made when it is first needed. It is the
  // transport's own: callers use emit/on/stream/state$.

  private get actor(): ActorStateUnit {
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
        // The SAME hook a refused request is renewed with — the stream asks
        // it once per outage before parking `unauthenticated`, an emit once
        // per emit, and no second refresh mechanism exists.
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
            const declared = asDeclared(channel, payload);
            for (const bus of this.bridges) bus.emit(channel, declared, envelope);
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
   * `docs/protocol/TRANSPORT-HTTP.md`): `Bus.request` registers its cid
   * here before emitting; the actor carries the tracked set as
   * `pendingReplies` on every subscribe body, so a reply published while
   * the connection was down replays from the server's retention buffer on
   * reconnect instead of being lost.
   */
  trackReply(correlationId: string): () => void {
    return this.actor.trackReply(correlationId);
  }

  /**
   * `Bus.request`'s fail-fast probe (`BusPrimitive.isSubscribed`):
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
    return this.ask('GET', CURRENT_USER, (http) => http.get(`${this.baseUrl}${CURRENT_USER}`, { headers: this.authHeaders() }).json<UserResponse>());
  }

  async getProtectedResourceMetadata(): Promise<ProtectedResourceMetadata> {
    const path = '/.well-known/oauth-protected-resource';
    return this.ask('GET', path, (http) => http.get(`${this.baseUrl}${path}`).json<ProtectedResourceMetadata>());
  }

  async getMediaToken(resourceId: ResourceId): Promise<{ token: string }> {
    const path = '/api/tokens/media';
    return this.ask('POST', path, (http) =>
      http.post(`${this.baseUrl}${path}`, { json: { resourceId }, headers: this.authHeaders() }).json<{ token: string }>());
  }

  // ── System status ─────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResponse> {
    const path = '/api/health';
    return this.ask('GET', path, (http) => http.get(`${this.baseUrl}${path}`, { headers: this.authHeaders() }).json<HealthCheckResponse>());
  }

  async getStatus(): Promise<StatusResponse> {
    const path = '/api/status';
    return this.ask('GET', path, (http) => http.get(`${this.baseUrl}${path}`, { headers: this.authHeaders() }).json<StatusResponse>());
  }

  // ── Internal: how the content transport asks ──────────────────────────

  /**
   * Ask this transport's `ky` instance for a request of `method` at `path`.
   * Every request of the transport is asked here, and `HttpContentTransport`
   * asks its content requests here: they pass through the same hooks, and
   * one the runtime will not make is reported as the others are, as a
   * request that got no answer, on `errors$`.
   */
  ask<T>(method: string, path: string, make: (http: KyInstance) => PromiseLike<T>): Promise<T> {
    return asked(method, path, () => make(this.http), (failure) => this.pushError(failure));
  }

  /**
   * The access token (synchronously read from the token source). Used by
   * the content transport, which sets its own `Authorization` header.
   */
  getToken(): AccessToken | undefined {
    return this.token$.getValue() ?? undefined;
  }

  /**
   * The token to send a request again with once the gateway has refused
   * `refused`: the refresher's, asked once, when it gives another
   * (docs/protocol/TRANSPORT-CONTRACT.md § A refused credential). None without
   * a refresher. The `ky` hook renews through it, and so does
   * `HttpContentTransport`'s `XMLHttpRequest` upload, which `ky` does not send.
   */
  async renewal(refused: string | undefined): Promise<string | null> {
    if (!this.config.tokenRefresher) return null;
    const renewed = await renewedToken(this.config.tokenRefresher);
    return renewed !== null && renewed !== refused ? renewed : null;
  }
}

// Re-export for convenience
export type { ConnectionState } from '@semiont/core';
