import type { BehaviorSubject, Observable } from 'rxjs';

/**
 * A state as its readers are given it: the value now (`getValue`) and each
 * value after it, and nothing that sets it. Whatever writes a state in a
 * `BehaviorSubject` hands out this view of it, so a reader cannot write past
 * what holds it: Python's `Watched`, Rust's `watch::Receiver`.
 */
export interface Watched<T> extends Observable<T> {
  getValue(): T;
}

/** The read-only view of a state held in `held`. */
export function watched<T>(held: BehaviorSubject<T>): Watched<T> {
  return Object.assign(held.asObservable(), { getValue: () => held.getValue() });
}
