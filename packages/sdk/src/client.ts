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

import type { ResourceId, BaseUrl } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { BrowseNamespace } from './namespaces/browse';
import { MarkNamespace } from './namespaces/mark';
import { BindNamespace } from './namespaces/bind';
import { GatherNamespace } from './namespaces/gather';
import { MatchNamespace } from './namespaces/match';
import { YieldNamespace } from './namespaces/yield';
import { BeckonNamespace } from './namespaces/beckon';
import { JobNamespace } from './namespaces/job';
import { AuthNamespace } from './namespaces/auth';
import { AdminNamespace } from './namespaces/admin';
import type { ITransport, IContentTransport } from '@semiont/core';

// Convenience re-exports of the HTTP adapters from @semiont/api-client so
// consumers can `import { SemiontClient, HttpTransport } from '@semiont/sdk'`
// without a separate api-client import. Non-HTTP transports
// (e.g. LocalTransport from @semiont/make-meaning) are wired directly by
// callers; the sdk does not pre-bundle them.
export {
  APIError,
  type TokenRefresher,
  HttpTransport,
  type HttpTransportConfig,
  HttpContentTransport,
} from '@semiont/api-client';

export class SemiontClient {
  /**
   * The wire-facing transport. Owns bus actor, HTTP, auth, admin, exchange,
   * system. Exposed for advanced consumers (workers, custom job adapters)
   * that need raw `transport.emit(channel, payload, scope)` access. Ordinary
   * consumers go through typed namespace methods.
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
  public readonly browse: BrowseNamespace;
  public readonly mark: MarkNamespace;
  public readonly bind: BindNamespace;
  public readonly gather: GatherNamespace;
  public readonly match: MatchNamespace;
  public readonly yield: YieldNamespace;
  public readonly beckon: BeckonNamespace;
  public readonly job: JobNamespace;
  public readonly auth: AuthNamespace;
  public readonly admin: AdminNamespace;

  /**
   * The client *owns* its bus. The constructor creates a fresh `EventBus`
   * and hands it to the transport via `transport.bridgeInto(this.bus)`.
   * The reference flows client → transport, never the other way:
   * the transport stores the reference and publishes the events it
   * receives onto that bus. `HttpTransport` does so for every channel
   * delivered on its SSE wire; in-process transports adapt their
   * internal source.
   *
   * Callers do not pass a bus in. If they need to interact with the bus
   * (e.g. for tests or to subscribe to arbitrary channels), they read it
   * back via `client.bus`.
   */
  constructor(transport: ITransport, content: IContentTransport) {
    this.transport = transport;
    this.content = content;
    this.baseUrl = transport.baseUrl;

    this.bus = new EventBus();
    this.transport.bridgeInto(this.bus);

    this.browse = new BrowseNamespace(this.transport, this.bus, this.content);
    this.mark   = new MarkNamespace(this.transport, this.bus);
    this.bind   = new BindNamespace(this.transport, this.bus);
    this.gather = new GatherNamespace(this.transport, this.bus);
    this.match  = new MatchNamespace(this.transport, this.bus);
    this.yield  = new YieldNamespace(this.transport, this.bus, this.content);
    this.beckon = new BeckonNamespace(this.transport, this.bus);
    this.job    = new JobNamespace(this.transport, this.bus);
    this.auth   = new AuthNamespace(this.transport);
    this.admin  = new AdminNamespace(this.transport);
  }

  /** Transport-level connection state. HTTP reflects SSE health; local is always 'connected'. */
  get state$() {
    return this.transport.state$;
  }

  subscribeToResource(resourceId: ResourceId): () => void {
    return this.transport.subscribeToResource(resourceId);
  }

  dispose(): void {
    this.transport.dispose();
    this.content.dispose();
  }
}
