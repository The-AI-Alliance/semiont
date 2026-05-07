/**
 * LocalTransport — `ITransport` for an in-process `KnowledgeSystem`.
 *
 * Bus-ownership pattern (see `docs/protocol/TRANSPORT-CONTRACT.md`):
 *   - The caller owns a make-meaning `EventBus` and passes it to both
 *     `startMakeMeaning` and `LocalTransport` so the transport can publish
 *     directly onto the bus the `KnowledgeSystem` actors are listening on.
 *   - `SemiontClient` constructs its own `clientBus` and calls
 *     `bridgeInto(clientBus)` during construction. `LocalTransport`
 *     subscribes to every `BRIDGED_CHANNELS` entry on the make-meaning bus
 *     and forwards each onto `clientBus`.
 *   - The bus reference flows client → transport, never the other way.
 *
 * LocalTransport implements `ITransport` only. Auth, admin, and exchange
 * (`IBackendOperations`) are HTTP-shaped concepts that don't apply
 * in-process — local mode runs as a single host-process identity supplied
 * at construction, with no token/credential lifecycle. A `SemiontClient`
 * built over this transport has no `.auth` / `.admin` namespaces.
 */

import type { Observable, Subscription } from 'rxjs';
import { BehaviorSubject, Subject } from 'rxjs';
import type { SemiontError } from '@semiont/core';
import type {
  BaseUrl,
  EventBus,
  EventMap,
  ResourceId,
  UserDID,
} from '@semiont/core';
import { baseUrl as makeBaseUrl, busLog } from '@semiont/core';
import { SpanKind, recordBusEmit, withSpan } from '@semiont/observability';
import {
  BRIDGED_CHANNELS,
  type ConnectionState,
  type ITransport,
} from '@semiont/core';

import type { KnowledgeSystem } from './knowledge-system.js';

export interface LocalTransportConfig {
  /**
   * The in-process knowledge system. Lifetime is owned by the caller —
   * `dispose()` on this transport does not stop the KnowledgeSystem.
   */
  knowledgeSystem: KnowledgeSystem;
  /**
   * The make-meaning `EventBus`. Must be the same instance passed to
   * `startMakeMeaning` so that emits land on the bus KnowledgeSystem
   * actors are subscribed to.
   */
  eventBus: EventBus;
  /**
   * Host-process identity. Stamped onto every emit as `_userId`, mirroring
   * the gateway-injection convention used by `HttpTransport` (where the
   * `/bus/emit` gateway reads the JWT subject and injects `_userId`).
   * Handlers downstream trust nothing else.
   */
  userId: UserDID;
  /**
   * Cosmetic base URL for diagnostics and URL composition. Defaults to
   * `local://in-process`. Local code never makes outgoing HTTP requests
   * with it.
   */
  baseUrl?: BaseUrl;
}

export class LocalTransport implements ITransport {
  readonly baseUrl: BaseUrl;
  readonly state$: BehaviorSubject<ConnectionState>;
  private readonly errorsSubject: Subject<SemiontError> = new Subject<SemiontError>();
  /**
   * Stream of `SemiontError` instances surfaced from transport-mediated
   * round-trips (typed-wire methods on this transport that fail). The
   * in-process implementation does not currently surface errors through
   * this stream — most failures here originate inside the make-meaning
   * actors and surface through bus channels (correlation-ID failures via
   * `busRequest`). The Subject exists to satisfy the `ITransport`
   * contract; future expansion (e.g. transport-level guard failures)
   * can publish into it.
   */
  readonly errors$: Observable<SemiontError> = this.errorsSubject.asObservable();

  private readonly bus: EventBus;
  private readonly userId: UserDID;
  private readonly bridges: EventBus[] = [];
  private readonly bridgeSubs: Subscription[] = [];
  private disposed = false;

  constructor(cfg: LocalTransportConfig) {
    this.bus = cfg.eventBus;
    this.userId = cfg.userId;
    this.baseUrl = cfg.baseUrl ?? makeBaseUrl('local://in-process');
    // Local "wire" is in-process. We start `open` and only close on dispose.
    this.state$ = new BehaviorSubject<ConnectionState>('open');
  }

  // ── Bus primitives ──────────────────────────────────────────────────────

  async emit<K extends keyof EventMap>(
    channel: K,
    payload: EventMap[K],
    resourceScope?: ResourceId,
  ): Promise<void> {
    busLog('EMIT', channel as string, payload, resourceScope as string | undefined);
    recordBusEmit(channel as string, resourceScope as string | undefined);
    await withSpan(
      `bus.emit:${channel as string}`,
      () => {
        // Gateway-injection: stamp the host identity onto every emit so
        // handlers can trust `_userId` regardless of which transport
        // delivered the event.
        const stamped = { ...(payload as object), _userId: this.userId };
        const target = resourceScope === undefined
          ? this.bus.get(channel)
          : this.bus.scope(resourceScope as unknown as string).get(channel);
        (target as unknown as { next(v: unknown): void }).next(stamped);
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

  on<K extends keyof EventMap>(channel: K, handler: (payload: EventMap[K]) => void): () => void {
    const sub = (this.bus.get(channel) as unknown as Observable<EventMap[K]>).subscribe(handler);
    return () => sub.unsubscribe();
  }

  stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.bus.get(channel) as unknown as Observable<EventMap[K]>;
  }

  subscribeToResource(_resourceId: ResourceId): () => void {
    // Local events are not scope-gated for delivery; emits to a scoped
    // channel still land on `bus.scope(...)` and any subscriber to that
    // scoped subject receives them. There is no ambient scope to "join".
    return () => {};
  }

  bridgeInto(bus: EventBus): void {
    if (this.bridges.includes(bus)) return;
    this.bridges.push(bus);
    for (const channel of BRIDGED_CHANNELS) {
      const upstream = this.bus.get(channel as keyof EventMap) as unknown as Observable<unknown>;
      this.bridgeSubs.push(
        upstream.subscribe((payload) => {
          busLog('RECV', channel, payload);
          // Tier 2: in-process — no _trace field on payload, parent
          // context comes from the active OTel context (inherited from
          // whichever code path emitted the event).
          void withSpan(
            `bus.recv:${channel}`,
            () => {
              (bus.get(channel as keyof EventMap) as unknown as { next(v: unknown): void }).next(payload);
            },
            { kind: SpanKind.CONSUMER, attrs: { 'bus.channel': channel } },
          );
        }),
      );
    }
  }

  // LocalTransport implements `ITransport` only. It does not implement
  // `IBackendOperations` — a SemiontClient built over LocalTransport has
  // no `client.auth` / `client.admin` namespaces by design (no
  // credentials, no admin routes, no exchange machinery in-process).

  // ── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sub of this.bridgeSubs) sub.unsubscribe();
    this.bridgeSubs.length = 0;
    this.bridges.length = 0;
    this.state$.next('closed');
    this.state$.complete();
    this.errorsSubject.complete();
  }
}
