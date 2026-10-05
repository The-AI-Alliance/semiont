/**
 * SemiontClient — the verb-oriented namespace surface.
 *
 * Thin coordinator over an injected transport pair. Owns a local
 * `EventBus` (`bus`) for UI-signal channels and bridges wire events into
 * it via `transport.bridgeInto(bus)`. Namespaces receive `(transport,
 * bus)` (and `content` for binary-I/O namespaces) and choose internally
 * whether each method goes over the wire or stays local.
 *
 * No public `emit`/`on`/`stream` shortcuts: consumers call typed
 * namespace methods. The single sanctioned channel-by-name escape hatch
 * is `SemiontSession.subscribe(channel, handler)`, which reads from
 * `client.bus`.
 */

import type { BaseUrl, AccessToken, CacheQuery } from '@semiont/core';
import { EventBus, accessToken, baseUrl } from '@semiont/core';
import type { SessionStorage } from './session/session-storage';
import { BehaviorSubject } from 'rxjs';
import { BrowseNamespace, type BROWSE_QUERIES } from './namespaces/browse';
import { MarkNamespace } from './namespaces/mark';
import { BindNamespace } from './namespaces/bind';
import { GatherNamespace, type GATHER_QUERIES } from './namespaces/gather';
import { MatchNamespace, type MATCH_QUERIES } from './namespaces/match';
import { YieldNamespace } from './namespaces/yield';
import { BeckonNamespace } from './namespaces/beckon';
import { FrameNamespace } from './namespaces/frame';
import { JobNamespace } from './namespaces/job';
import { AuthNamespace } from './namespaces/auth';
import { SystemNamespace } from './namespaces/system';
import type { IGatewayOperations, IContentTransport, ITransport } from '@semiont/core';

// Local imports of the HTTP adapters from @semiont/http-transport — needed
// here so `SemiontClient.fromHttp(...)` can construct them. The same
// names are re-exported below for consumer convenience, so
// `import { SemiontClient, HttpTransport } from '@semiont/sdk'` Just Works
// without a separate http-transport import.
import {
  HttpTransport,
  HttpContentTransport,
} from '@semiont/http-transport';

// Convenience re-exports of the HTTP adapters. Non-HTTP transports are
// wired directly by callers; the sdk does not pre-bundle them.
export {
  APIError,
  type TokenRefresher,
  HttpTransport,
  type HttpTransportConfig,
  HttpContentTransport,
} from '@semiont/http-transport';

/**
 * Every live query of specs/src/client/refresh.json is answered by one of
 * the namespaces that hold them, and no query by two: each namespace's
 * refresher acts only on its own, so one left out would never refresh, and
 * silently. A query added to the table and to no namespace fails to compile
 * here, naming it.
 */
type AnsweredQuery =
  | (typeof BROWSE_QUERIES)[number]
  | (typeof GATHER_QUERIES)[number]
  | (typeof MATCH_QUERIES)[number];
type AnsweredTwice =
  | ((typeof BROWSE_QUERIES)[number] & (typeof GATHER_QUERIES)[number])
  | ((typeof BROWSE_QUERIES)[number] & (typeof MATCH_QUERIES)[number])
  | ((typeof GATHER_QUERIES)[number] & (typeof MATCH_QUERIES)[number]);
type LiveQueryCensusDrift = Exclude<CacheQuery, AnsweredQuery> | AnsweredTwice;
export const liveQueryCensus: [LiveQueryCensusDrift] extends [never] ? 'in-census' : LiveQueryCensusDrift = 'in-census';

export class SemiontClient {
  /**
   * The wire-facing transport: the bus primitives, resource scopes, and the
   * connection's state and errors. Exposed for advanced consumers (workers,
   * custom job adapters) that need raw `transport.emit(channel, payload,
   * envelope)` access. Ordinary consumers go through typed namespace methods.
   */
  readonly transport: ITransport;
  /** Binary I/O transport. */
  private readonly content: IContentTransport;
  /**
   * Per-client local EventBus. Wire events flow in via the transport
   * bridge. Read-only public so `SemiontSession.subscribe(channel, …)`
   * can wire arbitrary-channel subscriptions; everything else uses
   * typed namespace methods.
   */
  readonly bus: EventBus;
  readonly baseUrl: BaseUrl;

  // ── Verb-oriented namespace API ──────────────────────────────────────────
  //
  // The first nine namespaces are bus-driven and always present. `frame`
  // is the schema-layer flow's surface (eighth flow); the other eight are
  // content-layer flows plus `job`. `auth` and `system` are gateway-ops
  // namespaces — they're only constructed when the caller passes an
  // `IGatewayOperations` instance to the constructor. A `SemiontClient`
  // over a transport-only setup has
  // `auth === undefined` / `system === undefined`.
  public readonly frame: FrameNamespace;
  public readonly browse: BrowseNamespace;
  public readonly mark: MarkNamespace;
  public readonly bind: BindNamespace;
  public readonly gather: GatherNamespace;
  public readonly match: MatchNamespace;
  public readonly yield: YieldNamespace;
  public readonly beckon: BeckonNamespace;
  public readonly job: JobNamespace;
  public readonly auth: AuthNamespace | undefined;
  public readonly system: SystemNamespace | undefined;

  /**
   * The client *owns* its bus. The constructor creates a fresh `EventBus`
   * and hands it to the transport via `transport.bridgeInto(this.bus)`.
   * The reference flows client → transport, never the other way:
   * the transport stores the reference and publishes the events it
   * receives onto that bus. `HttpTransport` does so for every channel
   * delivered on its SSE wire; a transport with no wire adapts its
   * own source.
   *
   * Callers do not pass a bus in. If they need to interact with the bus
   * (e.g. for tests or to subscribe to arbitrary channels), they read it
   * back via `client.bus`.
   *
   * `gateway` is optional. When provided, the `auth` and `system`
   * namespaces are constructed against it; when omitted, they're
   * `undefined`. For HTTP setups this is conventionally the same
   * `HttpTransport` instance that's also passed as `transport` (HTTP
   * implements both `ITransport` and `IGatewayOperations`).
   */
  constructor(
    transport: ITransport,
    content: IContentTransport,
    gateway?: IGatewayOperations,
    options?: {
      /**
       * B17 — cache persistence through the environment's SessionStorage
       * adapter (keyPrefix = KB id). Omitted = in-memory-only caches.
       */
      cachePersistence?: { storage: SessionStorage; keyPrefix: string };
      /**
       * `busRequest` timeout for the browse caches — threads through to
       * `BrowseNamespace`'s deterministic-time knob, there so the liveness
       * property suite can control time. Production omits it (30 s
       * default); `@semiont/sdk/testing` passes small values so B14/B15
       * chains run in test time.
       */
      busTimeoutMs?: number;
      /**
       * The window bus-driven invalidations of one key coalesce in (B19),
       * `invalidationWindowMs` of specs/src/client/timing.json. Production
       * omits it; a test or the conformance driver passes a small value.
       */
      invalidationWindowMs?: number;
      /**
       * How long a followed job may be silent before its status is asked for,
       * and how often after that: `jobSilenceMs` and `jobStatusPollMs` of
       * specs/src/client/timing.json. Production omits them.
       */
      jobSilenceMs?: number;
      jobStatusPollMs?: number;
    },
  ) {
    this.transport = transport;
    this.content = content;
    this.baseUrl = transport.baseUrl;

    this.bus = new EventBus();
    this.transport.bridgeInto(this.bus);

    this.frame  = new FrameNamespace(this.transport);
    // What every namespace holding live queries takes.
    const liveQueryTiming = {
      ...(options?.busTimeoutMs !== undefined ? { busTimeoutMs: options.busTimeoutMs } : {}),
      ...(options?.invalidationWindowMs !== undefined ? { invalidationWindowMs: options.invalidationWindowMs } : {}),
    };
    this.browse = new BrowseNamespace(this.transport, this.bus, this.content, {
      ...(options?.cachePersistence ? { cachePersistence: options.cachePersistence } : {}),
      ...liveQueryTiming,
    });
    const jobFollowTiming = {
      ...(options?.jobSilenceMs !== undefined ? { jobSilenceMs: options.jobSilenceMs } : {}),
      ...(options?.jobStatusPollMs !== undefined ? { jobStatusPollMs: options.jobStatusPollMs } : {}),
    };
    this.mark   = new MarkNamespace(this.transport, this.bus, jobFollowTiming);
    this.bind   = new BindNamespace(this.transport, this.bus);
    this.gather = new GatherNamespace(this.transport, this.bus, liveQueryTiming);
    this.match  = new MatchNamespace(this.transport, this.bus, liveQueryTiming);
    this.yield  = new YieldNamespace(this.transport, this.bus, this.content, jobFollowTiming);
    this.beckon = new BeckonNamespace(this.transport, this.bus);
    this.job    = new JobNamespace(this.transport, this.bus);
    this.auth   = gateway ? new AuthNamespace(gateway)  : undefined;
    this.system = gateway ? new SystemNamespace(gateway) : undefined;
  }

  /** Transport-level connection state. HTTP reflects SSE health; local is `'open'` until disposed. */
  get state$() {
    return this.transport.state$;
  }

  dispose(): void {
    // The live queries first: completing their caches stops any SWR
    // fetch/retry chain from issuing new requests into a transport that's
    // about to go away (B16 — a chain straddling teardown must die quietly,
    // not error observers or fire post-dispose traffic).
    this.browse.dispose();
    this.gather.dispose();
    this.match.dispose();
    this.transport.dispose();
    this.content.dispose();
    // Bus last (A7-owned: this client constructed it): everything upstream
    // is already quiet — the live queries detached their handlers, the transport's SSE
    // fan-in is down — so destroying it completes every remaining
    // subscriber cleanly (session.subscribe closures, host code holding
    // client.bus). Without this, the bus outlives the client and every
    // subscriber stays attached forever, silently receiving nothing — one
    // leaked bus per session cycle under a reconnect loop. Post-dispose
    // bus access — any bus-emitting namespace method — throws
    // `destroyed bus` instead of no-op'ing into the leak: calling a
    // disposed client is a bug, and it says so.
    this.bus.destroy();
  }

  /**
   * Convenience factory for the default HTTP setup. Constructs a
   * `BehaviorSubject<AccessToken | null>` internally, plus an
   * `HttpTransport` and `HttpContentTransport`, and returns the wired
   * `SemiontClient`.
   *
   * Use this for one-shot scripts, CLI commands, or any consumer that
   * doesn't need to drive the token from outside (no manual refresh,
   * no cross-tab sync). For long-running scripts that need refresh,
   * use `SemiontSession.fromHttp(...)` (with a token already on hand)
   * or `SemiontSession.signInDevice(...)` (sign in at the issuer) instead —
   * either owns the same transport/client wiring plus the
   * proactive-refresh + storage machinery.
   *
   * Strings are accepted for `baseUrl` and `token`; they are branded
   * via `baseUrl()` / `accessToken()` from `@semiont/core` automatically.
   * Pass the already-branded values if you have them.
   *
   * Omit `token` for unauthenticated usage (public endpoints only).
   */
  static fromHttp(opts: {
    baseUrl: BaseUrl | string;
    token?: AccessToken | string | null;
  }): SemiontClient {
    const url = typeof opts.baseUrl === 'string' ? baseUrl(opts.baseUrl) : opts.baseUrl;
    const tok = opts.token == null
      ? null
      : (typeof opts.token === 'string' ? accessToken(opts.token) : opts.token);
    const token$ = new BehaviorSubject<AccessToken | null>(tok);
    const transport = new HttpTransport({ baseUrl: url, token$ });
    const content = new HttpContentTransport(transport);
    // HttpTransport implements both ITransport and IGatewayOperations;
    // pass it twice so `client.auth` / `client.system` are wired.
    return new SemiontClient(transport, content, transport);
  }

}
