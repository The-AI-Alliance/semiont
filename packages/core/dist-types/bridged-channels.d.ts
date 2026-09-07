import type { EventName } from './bus-protocol';
import { BUS_OPERATIONS } from './bus-operations';
/**
 * BRIDGED_CHANNELS
 *
 * The set of bus channels that any concrete transport bridges into the
 * caller-supplied bus via `bridgeInto`. Transport-neutral: every concrete
 * `ITransport` shares the same set; HTTP delivers them via SSE, in-process
 * transports forward them directly from the local actor bus.
 *
 * This is the *fan-in* set — channels for events the transport receives and
 * pushes onto the client's bus. It is not the same as the channels the client
 * emits (which is open-ended).
 *
 * It is DERIVED, not hand-listed: the request/reply replies come from
 * `BUS_OPERATIONS` (bus-operations.ts), so no operation's reply can be
 * forgotten here — that was the recurring unbridged-reply bug class. The only
 * hand-maintained part is `BRIDGED_BROADCASTS`: the genuine non-request/reply
 * minority (lifecycle events and UI/infra signals that no single requester
 * owns). See .plans/BUS-OPERATIONS-REGISTRY.md.
 *
 * Resource-scoped channels (joined/left via `subscribeToResource`) are tracked
 * separately by transports that care about scope (HTTP).
 */
/**
 * Bridged channels with no owning operation: job-lifecycle events (multi-viewer,
 * no single requester owns the reply), KB-global frame domain events, UI signals,
 * and SSE infrastructure. A reply channel must NOT go here — declare its
 * operation in `BUS_OPERATIONS` instead.
 */
export declare const BRIDGED_BROADCASTS: readonly ["job:report-progress", "job:complete", "job:fail", "frame:entity-type-added", "frame:tag-schema-added", "yield:created", "yield:updated", "yield:cloned", "yield:moved", "beckon:focus", "beckon:sparkle", "bus:resume-gap", "browse:resource-open", "browse:resource-viewed", "session:joined", "session:left", "browse:click"];
type OpSpecs = (typeof BUS_OPERATIONS)[keyof typeof BUS_OPERATIONS];
type ProgressChannel<O> = O extends {
    progress: infer P extends EventName;
} ? P : never;
/** The union of every reply channel declared in the registry. */
type RegistryReply = OpSpecs['result'] | OpSpecs['failure'] | ProgressChannel<OpSpecs>;
export declare const BRIDGED_CHANNELS: readonly BridgedChannel[];
/**
 * The SUBSCRIBE-side subset of `EventName` — the channels a client can receive
 * over a concrete transport. See the family note on `EventName` in
 * bus-protocol.ts (emit on an `EmittableChannel`, subscribe on a `BridgedChannel`).
 */
export type BridgedChannel = RegistryReply | (typeof BRIDGED_BROADCASTS)[number];
export {};
