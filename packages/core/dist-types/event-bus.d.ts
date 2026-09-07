/**
 * RxJS-based Event Bus
 *
 * Framework-agnostic event bus providing direct access to typed RxJS Subjects.
 *
 * Can be used in Node.js, browser, workers, CLI - anywhere RxJS runs.
 */
import { Subject } from 'rxjs';
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
export declare class EventBus {
    private subjects;
    private isDestroyed;
    constructor();
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
    get<K extends keyof EventMap>(eventName: K): Subject<EventMap[K]>;
    /**
     * Get the RxJS Subject for a domain event type (PersistedEventType).
     *
     * Domain event channels carry `StoredEvent`. This method avoids the need
     * for `as keyof EventMap` casts when subscribing to domain event channels
     * using runtime `PersistedEventType` strings.
     */
    getDomainEvent(eventType: PersistedEventType): Subject<StoredEvent>;
    /**
     * Channel names with at least one live observer right now. Introspection
     * for composition-parity gates: `get()` creates subjects lazily, so mere
     * access does not count — only real subscriptions do. Scoped channels
     * appear under their namespaced key (`<scope>:<channel>`).
     */
    observedChannels(): string[];
    /**
     * Destroy the event bus and complete all subjects
     *
     * After calling destroy(), no new events can be emitted or subscribed to.
     * All active subscriptions will be completed.
     */
    destroy(): void;
    /**
     * Check if the event bus has been destroyed
     */
    get destroyed(): boolean;
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
    scope(resourceId: string): ScopedEventBus;
}
/**
 * Resource-scoped event bus
 *
 * Provides isolated event streams per resource while maintaining the same API
 * as the parent EventBus. Events are internally namespaced by resourceId.
 */
export declare class ScopedEventBus {
    private parent;
    private scopePrefix;
    constructor(parent: EventBus, scopePrefix: string);
    /**
     * Get the RxJS Subject for a scoped event
     *
     * Returns the same type as the parent bus, but events are isolated to this scope.
     * Internally uses namespaced keys but preserves type safety.
     *
     * @param event - The event name
     * @returns The RxJS Subject for this scoped event
     */
    get<E extends keyof EventMap>(event: E): Subject<EventMap[E]>;
    /** Get the RxJS Subject for a domain event type on this scoped bus. */
    getDomainEvent(eventType: PersistedEventType): Subject<StoredEvent>;
    /**
     * Create a nested scope
     *
     * Allows hierarchical scoping like `resource-1:subsystem-a`
     *
     * @param subScope - Additional scope level
     * @returns A nested scoped event bus
     */
    scope(subScope: string): ScopedEventBus;
}
