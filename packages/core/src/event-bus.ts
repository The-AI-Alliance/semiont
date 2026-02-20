/**
 * RxJS-based Event Bus
 *
 * Framework-agnostic event bus providing direct access to typed RxJS Subjects.
 *
 * Can be used in Node.js, browser, workers, CLI - anywhere RxJS runs.
 */

import { Subject } from 'rxjs';
import type { EventMap } from './event-map';

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
 * eventBus.get('annotation:hover').next({ annotationId: 'ann-1' });
 *
 * // Subscribe to events
 * const subscription = eventBus.get('annotation:hover').subscribe(({ annotationId }) => {
 *   console.log('Hover:', annotationId);
 * });
 *
 * // Use RxJS operators
 * import { debounceTime } from 'rxjs/operators';
 * eventBus.get('annotation:hover')
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
   * eventBus.get('annotation:hover').next({ annotationId: 'ann-1' });
   *
   * // Subscribe
   * const sub = eventBus.get('annotation:hover').subscribe(handleHover);
   *
   * // With operators
   * eventBus.get('annotation:hover')
   *   .pipe(debounceTime(100), distinctUntilChanged())
   *   .subscribe(handleHover);
   * ```
   */
  get<K extends keyof EventMap>(eventName: K): Subject<EventMap[K]> {
    if (this.isDestroyed) {
      throw new Error(`Cannot access event '${String(eventName)}' on destroyed bus`);
    }

    if (!this.subjects.has(eventName)) {
      this.subjects.set(eventName, new Subject<EventMap[K]>());
    }
    return this.subjects.get(eventName)!;
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
}
