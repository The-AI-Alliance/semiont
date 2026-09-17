/**
 * RxJS-based Event Bus
 *
 * Framework-agnostic event bus providing direct access to typed RxJS Subjects.
 *
 * Can be used in Node.js, browser, workers, CLI - anywhere RxJS runs.
 */

import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { busLog, busLogEnabled, warnIfUnobservedReply, warnUnobservedRepliesEnabled } from './bus-log';
import type { EventMap } from './bus-protocol';

/**
 * What the bus carries: a FRAME, not a bare payload.
 *
 * Routing metadata rides the envelope and never enters a channel's domain
 * type — the rule `BusEmitRequest.clientId` already states for the wire
 * (BUS-ROUTING-DECLARED D2). In-process it had nowhere to live, so
 * `correlationId` was declared in 71 payload schemas and echoed by hand in
 * nine handlers, and `scope` became a channel-key prefix: one fact with two
 * representations depending on the layer.
 *
 * A handler cannot tell which fabric it is on — that is the property the
 * signal plane is built on — so the envelope it reads must not depend on the
 * fabric. This is the same frame the wire carries.
 */
export interface BusFrame<T> {
  /** Correlates a reply with its request. Absent on an announcement. */
  readonly correlationId?: string;
  /** The resource scope this frame was emitted into. Absent means global. */
  readonly scope?: string;
  readonly payload: T;
}

/** The envelope half, for `emit`. */
export type BusEnvelope = Omit<BusFrame<never>, 'payload'>;

/**
 * RxJS-based event bus.
 *
 * THREE VERBS, each answering one question, and no caller ever holds a
 * Subject. `get()` used to hand one out, which meant nothing distinguished
 * publishing from observing — every holder could write, read and pipe the
 * same object — and that is what let the payload/envelope conflation stay
 * invisible.
 *
 * @example
 * ```typescript
 * const eventBus = new EventBus();
 *
 * // Emit events
 * eventBus.emit('beckon:hover', { annotationId: 'ann-1' });
 *
 * // Subscribe to events
 * const subscription = eventBus.on('beckon:hover').subscribe(({ annotationId }) => {
 *   console.log('Hover:', annotationId);
 * });
 *
 * // Use RxJS operators
 * import { debounceTime } from 'rxjs/operators';
 * eventBus.on('beckon:hover')
 *   .pipe(debounceTime(100))
 *   .subscribe(handleHover);
 *
 * // Cleanup
 * subscription.unsubscribe();
 * eventBus.destroy();
 * ```
 */
export class EventBus {
  private subjects: Map<keyof EventMap, Subject<any>>;
  private isDestroyed: boolean;
  /**
   * Observers per (channel, scope). One Subject now carries every scope of a
   * channel, so `subject.observers.length` counts subscribers of OTHER scopes
   * too — and `emit`'s count is load-bearing: the gateway turns zero into a
   * synthesized `peer-unavailable`. Separate subjects used to make this
   * accurate by accident; one stream has to keep the tally on purpose.
   */
  private observerCounts: Map<string, number> = new Map();

  constructor() {
    this.subjects = new Map();
    this.isDestroyed = false;
  }

  /**
   * Get the RxJS Subject for an event
   *
   * Returns a typed Subject that can be used with all RxJS operators.
   * Subjects are created lazily on first access.
   *
   * @param eventName - The event name
   * @returns The RxJS Subject for this event
   *
   * @example
   * ```typescript
   * // Emit
   * eventBus.emit('beckon:hover', { annotationId: 'ann-1' });
   *
   * // Subscribe
   * const sub = eventBus.on('beckon:hover').subscribe(handleHover);
   *
   * // With operators
   * eventBus.on('beckon:hover')
   *   .pipe(debounceTime(100), distinctUntilChanged())
   *   .subscribe(handleHover);
   * ```
   */
  /**
   * The one write path. An envelope is optional per FIELD, never per frame:
   * an announcement simply carries no correlationId.
   */
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K], envelope: BusEnvelope = {}): number {
    const stream = this.channel(channel);
    // Observability rides the ONE write path now. It used to wrap `next` on
    // the subject handed out by `get()`, which meant it was installed per
    // channel at first access and had to be re-wrapped for every new holder.
    if (busLogEnabled()) busLog('EMIT', String(channel), payload as object, envelope.scope, envelope.correlationId);
    if (warnUnobservedRepliesEnabled()) {
      warnIfUnobservedReply(String(channel), envelope.correlationId, stream.observers.length);
    }
    // The observer count AT DISPATCH, matching `ITransport.emit` on the wire
    // and feeding the plane's `IngestReceipt.observers`. Zero is the signal
    // the gateway turns into a synthesized `peer-unavailable` rather than
    // letting a caller wait out its timeout, so it is load-bearing, not
    // telemetry. Counted before delivery: a subscriber that unsubscribes in
    // its own handler was still reached.
    const observers = this.observersOf(channel, undefined);
    stream.next({ ...envelope, payload });
    return observers;
  }

  /** The payload view, DERIVED from `frames` so the two cannot disagree. */
  on<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.frames(channel).pipe(map((frame) => frame.payload));
  }

  /**
   * The envelope view: what a correlating handler reads to echo a reply back
   * to its requester, and what a scope-aware reader inspects.
   *
   * Global by default — a frame emitted into a resource scope is NOT seen
   * here. Separate subjects gave that isolation for free; one stream and a
   * filter has to state it.
   */
  frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>> {
    return this.viewOf(channel, undefined);
  }

  /** @internal — one filtered, observer-counted view per (channel, scope). */
  viewOf<K extends keyof EventMap>(channel: K, scope: string | undefined): Observable<BusFrame<EventMap[K]>> {
    const key = `${scope ?? ''}\u0000${String(channel)}`;
    // `asObservable()` before piping, deliberately: `Subject.pipe()` returns
    // an AnonymousSubject, which still carries `next`, so piping alone would
    // hand every reader a write path back to the channel.
    const view = this.channel(channel)
      .asObservable()
      .pipe(filter((frame) => frame.scope === scope));
    return new Observable<BusFrame<EventMap[K]>>((subscriber) => {
      this.observerCounts.set(key, (this.observerCounts.get(key) ?? 0) + 1);
      const inner = view.subscribe(subscriber);
      return () => {
        this.observerCounts.set(key, (this.observerCounts.get(key) ?? 1) - 1);
        inner.unsubscribe();
      };
    });
  }

  /** @internal — observers of one (channel, scope) view, for `emit`. */
  observersOf(channel: keyof EventMap, scope: string | undefined): number {
    return this.observerCounts.get(`${scope ?? ''}\u0000${String(channel)}`) ?? 0;
  }

  /** Every frame on a channel, scoped or not. Internal to the scoped view. */
  private channel<K extends keyof EventMap>(channel: K): Subject<BusFrame<EventMap[K]>> {
    if (this.isDestroyed) {
      throw new Error(`Cannot access event '${String(channel)}' on destroyed bus`);
    }
    if (!this.subjects.has(channel)) {
      this.subjects.set(channel, new Subject<BusFrame<EventMap[K]>>());
    }
    return this.subjects.get(channel)!;
  }

  /** @internal — the scoped view reads and writes the same per-channel stream. */
  channelStream<K extends keyof EventMap>(channel: K): Subject<BusFrame<EventMap[K]>> {
    return this.channel(channel);
  }

  /**
   * Channel names with at least one live observer right now. Introspection
   * for composition-parity gates: `get()` creates subjects lazily, so mere
   * access does not count — only real subscriptions do. Scoped channels
   * appear under their namespaced key (`<scope>:<channel>`).
   */
  observedChannels(): string[] {
    const out: string[] = [];
    for (const [name, subject] of this.subjects) {
      if (subject.observed) out.push(String(name));
    }
    return out;
  }

  /**
   * Destroy the event bus and complete all subjects
   *
   * After calling destroy(), no new events can be emitted or subscribed to.
   * All active subscriptions will be completed.
   */
  destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    for (const subject of this.subjects.values()) {
      subject.complete();
    }

    this.subjects.clear();
    this.isDestroyed = true;
  }

  /**
   * Check if the event bus has been destroyed
   */
  get destroyed(): boolean {
    return this.isDestroyed;
  }

  /**
   * Create a resource-scoped event bus
   *
   * Events emitted or subscribed through the scoped bus are isolated to that resource.
   * Internally, events are namespaced but the API remains identical to the parent bus.
   *
   * @param resourceId - Resource identifier to scope events to
   * @returns A scoped event bus for this resource
   *
   * @example
   * ```typescript
   * const eventBus = new EventBus();
   * const resource1 = eventBus.scope('resource-1');
   * const resource2 = eventBus.scope('resource-2');
   *
   * // These are isolated - only resource1 subscribers will fire
   * resource1.get('detection:progress').next({ status: 'started' });
   * ```
   */
  scope(resourceId: string): ScopedEventBus {
    return new ScopedEventBus(this, resourceId);
  }
}

/**
 * Resource-scoped event bus
 *
 * Provides isolated event streams per resource while maintaining the same API
 * as the parent EventBus. Events are internally namespaced by resourceId.
 */
export class ScopedEventBus {
  constructor(
    private parent: EventBus,
    private scopePrefix: string
  ) {}

  /**
   * Get the RxJS Subject for a scoped event
   *
   * Returns the same type as the parent bus, but events are isolated to this scope.
   * Internally uses namespaced keys but preserves type safety.
   *
   * @param event - The event name
   * @returns The RxJS Subject for this scoped event
   */
  /** Emit into this scope. The scope is a FIELD on the frame, not a prefix
   *  on the channel name — one channel, one stream, and a reader can see the
   *  scope rather than having to parse it out of a key. */
  emit<K extends keyof EventMap>(channel: K, payload: EventMap[K], envelope: BusEnvelope = {}): number {
    const observers = this.parent.observersOf(channel, this.scopePrefix);
    this.parent.channelStream(channel).next({ ...envelope, scope: this.scopePrefix, payload });
    return observers;
  }

  /** The payload view for this scope, derived from `frames` as it is globally. */
  on<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
    return this.frames(channel).pipe(map((frame) => frame.payload));
  }

  /** Frames emitted into THIS scope only. */
  frames<K extends keyof EventMap>(channel: K): Observable<BusFrame<EventMap[K]>> {
    return this.parent.viewOf(channel, this.scopePrefix);
  }

  /**
   * Create a nested scope
   *
   * Allows hierarchical scoping like `resource-1:subsystem-a`
   *
   * @param subScope - Additional scope level
   * @returns A nested scoped event bus
   */
  scope(subScope: string): ScopedEventBus {
    return new ScopedEventBus(this.parent, `${this.scopePrefix}:${subScope}`);
  }
}
