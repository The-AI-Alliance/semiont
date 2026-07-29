/**
 * WorkerBus — minimal channel-bus surface that worker-side adapters
 * (e.g. `JobClaimAdapter` in `@semiont/jobs`, `SmelterActorStateUnit` in
 * `@semiont/make-meaning`) need.
 *
 * Transport-neutral by design. HTTP `ActorStateUnit` (from `@semiont/http-transport`)
 * satisfies it directly; an in-process worker can pass a small shim around
 * an `EventBus` with a `() => Promise<void>` `emit` that calls into the
 * actor system.
 *
 * `addChannels` is optional because in-process buses receive every emit
 * implicitly — only HTTP needs to widen its SSE subscription set to
 * include worker-only channels (`job:queued`, `yield:created`, etc.).
 */

import type { Observable } from 'rxjs';
import type { ConnectionState } from '@semiont/core';

export interface WorkerBus {
  on$<T = Record<string, unknown>>(channel: string): Observable<T>;
  emit(channel: string, payload: Record<string, unknown>): Promise<void>;
  /**
   * Connection state of the stream that delivers replies. Required
   * (.plans/BUS-ATTACH-GATE.md D2): worker-side `busRequest`s gate their
   * emit on it — a worker's first `job:claim` right after connect is
   * exactly the attach-window emit the gate exists for. HTTP
   * `ActorStateUnit` exposes it already; in-process shims report `'open'`
   * (delivery is synchronous — there is no window).
   */
  state$: Observable<ConnectionState>;
  addChannels?(channels: readonly string[]): void;
}
