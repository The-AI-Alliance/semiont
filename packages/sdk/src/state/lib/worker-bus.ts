/**
 * WorkerBus — minimal channel-bus surface that worker-side adapters
 * (e.g. `JobClaimAdapter` in `@semiont/jobs`, `SmelterActorStateUnit` in
 * `@semiont/make-meaning`) need.
 *
 * Transport-neutral by design. HTTP `ActorStateUnit` (from `@semiont/api-client`)
 * satisfies it directly; an in-process worker can pass a small shim around
 * an `EventBus` with a `() => Promise<void>` `emit` that calls into the
 * actor system.
 *
 * `addChannels` is optional because in-process buses receive every emit
 * implicitly — only HTTP needs to widen its SSE subscription set to
 * include worker-only channels (`job:queued`, `yield:created`, etc.).
 */

import type { Observable } from 'rxjs';

export interface WorkerBus {
  on$<T = Record<string, unknown>>(channel: string): Observable<T>;
  emit(channel: string, payload: Record<string, unknown>): Promise<void>;
  addChannels?(channels: readonly string[]): void;
}
