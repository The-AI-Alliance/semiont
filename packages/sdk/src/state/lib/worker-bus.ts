/**
 * WorkerBus — what a worker-side adapter needs from a bus, which is
 * `BusRequestPrimitive` plus the one thing an SSE connection has and an
 * in-process bus does not: the ability to widen its subscription set.
 *
 * Transport-neutral by design. HTTP `ActorStateUnit` (from
 * `@semiont/http-transport`) satisfies it directly; an in-process worker
 * passes `workerBusOverEventBus`, a shim around a core `EventBus`.
 *
 * It did not always extend anything. Until 2026-09-12 it restated `emit`,
 * `state$` and `isSubscribed` itself and called its stream method `on$`,
 * which left it a near-copy of `BusRequestPrimitive` differing in one
 * method's NAME — so `workerBusAsPrimitive` existed purely to rename `on$`
 * to `stream`, and every worker-side `busRequest` was routed through it.
 * Renaming the method deleted the adapter and the duplication together
 * (WORKER-BUS-TYPED-BY-CHANNEL D4/D6).
 *
 * The types come from the channel name, never from a caller (D1): there is
 * no type parameter to supply and no channel outside `EventMap` to name.
 * `stream` was `on$<T = Record<string, unknown>>(channel: string)`, and the
 * default was the real damage — a payload nobody had typed and one typed
 * wrongly were the same type, so `job:queued`'s consumer could hand-write a
 * copy of the spec's shape, drop `userId`, and compile for months.
 */

import type { BusRequestPrimitive, EventMap } from '@semiont/core';

export interface WorkerBus extends BusRequestPrimitive {
  /**
   * Widen the receive path to include `channels`.
   *
   * Optional because in-process buses receive every emit implicitly — only
   * an SSE connection has a subscription set to widen, and only it has to be
   * told about worker-only channels (`job:queued`, `yield:created`).
   *
   * Registry keys, not strings: a channel this cannot name is a channel
   * nothing declares.
   */
  addChannels?(channels: readonly (keyof EventMap)[]): void;
}
