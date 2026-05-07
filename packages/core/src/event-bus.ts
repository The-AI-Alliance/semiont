/**
 * RxJS-based Event Bus
 *
 * Framework-agnostic event bus providing direct access to typed RxJS Subjects.
 *
 * Can be used in Node.js, browser, workers, CLI - anywhere RxJS runs.
 */

import { Subject } from 'rxjs';
import { busLog, busLogEnabled } from './bus-log';
import type { EventMap } from './bus-protocol';
import type { StoredEvent } from './event-base';
import type { PersistedEventType } from './persisted-events';

/**
 * RxJS-based event bus
 *
 * Provides direct access to RxJS Subjects for each event type.
 * Use standard RxJS patterns for emitting and subscribing.
 *
 * @example
 * ```typescript
 * const eventBus = new EventBus();
 *
 * // Emit events
 * eventBus.get('beckon:hover').next({ annotationId: 'ann-1' });
 *
 * // Subscribe to events
 * const subscription = eventBus.get('beckon:hover').subscribe(({ annotationId }) => {
 *   console.log('Hover:', annotationId);
 * });
 *
 * // Use RxJS operators
 * import { debounceTime } from 'rxjs/operators';
 * eventBus.get('beckon:hover')
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
   * eventBus.get('beckon:hover').next({ annotationId: 'ann-1' });
   *
   * // Subscribe
   * const sub = eventBus.get('beckon:hover').subscribe(handleHover);
   *
   * // With operators
   * eventBus.get('beckon:hover')
   *   .pipe(debounceTime(100), distinctUntilChanged())
   *   .subscribe(handleHover);
   * ```
   */
  get<K extends keyof EventMap>(eventName: K): Subject<EventMap[K]> {
    if (this.isDestroyed) {
      throw new Error(`Cannot access event '${String(eventName)}' on destroyed bus`);
    }

    if (!this.subjects.has(eventName)) {
      const subject = new Subject<EventMap[K]>();
      // When bus-log is enabled (`SEMIONT_BUS_LOG=1` or
      // `window.__SEMIONT_BUS_LOG__ = true`), wrap `.next()` so every
      // local emit on this channel produces a `[bus EMIT] <channel> ...`
      // line on `console.debug` — same shape as cross-wire emits from
      // HttpTransport. This is what makes local-only fan-out signals
      // (`beckon.hover`, `beckon.sparkle`, `mark.changeShape`, etc.)
      // visible to the e2e bus capture and to a developer's DevTools.
      // The `busLogEnabled()` check is at first-`get` time per channel;
      // setting the flag after channels are constructed won't
      // retroactively wrap them. The bus capture fixture uses
      // `addInitScript` so the flag is set before any namespace
      // construction, which is when `get()` is first called.
      if (busLogEnabled()) {
        const originalNext = subject.next.bind(subject);
        subject.next = (value: EventMap[K]): void => {
          busLog('EMIT', String(eventName), value as object);
          originalNext(value);
        };
      }
      this.subjects.set(eventName, subject);
    }
    return this.subjects.get(eventName)!;
  }

  /**
   * Get the RxJS Subject for a domain event type (PersistedEventType).
   *
   * Domain event channels carry `StoredEvent`. This method avoids the need
   * for `as keyof EventMap` casts when subscribing to domain event channels
   * using runtime `PersistedEventType` strings.
   */
  getDomainEvent(eventType: PersistedEventType): Subject<StoredEvent> {
    return this.get(eventType as keyof EventMap) as unknown as Subject<StoredEvent>;
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
  get<E extends keyof EventMap>(event: E): Subject<EventMap[E]> {
    // Internally namespace the event key, but preserve return type
    const scopedKey = `${this.scopePrefix}:${event as string}`;

    // Access parent's subjects map directly (needs cast for private access)
    const parentSubjects = (this.parent as any).subjects as Map<string, Subject<any>>;

    if (!parentSubjects.has(scopedKey)) {
      parentSubjects.set(scopedKey, new Subject<EventMap[E]>());
    }
    return parentSubjects.get(scopedKey)!;
  }

  /** Get the RxJS Subject for a domain event type on this scoped bus. */
  getDomainEvent(eventType: PersistedEventType): Subject<StoredEvent> {
    return this.get(eventType as keyof EventMap) as unknown as Subject<StoredEvent>;
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
