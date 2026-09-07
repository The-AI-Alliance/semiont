import { Observable } from 'rxjs';
import { SemiontError } from './errors';
import type { EventMap, EventName } from './bus-protocol';
import type { ConnectionState } from './transport';
import { BUS_OPERATIONS, type BusOperationKey } from './bus-operations';
/**
 * The value a registered operation resolves to: the `response` field of its
 * result channel's payload, or `void` for a result channel that carries no
 * `response` (a confirmed-write ack with no data). Inferred from the registry,
 * so callers never annotate `busRequest`'s return type. Relies on the reply-shape
 * standard — see .plans/REPLY-SHAPE-STANDARD.md.
 */
export type BusReply<Op extends BusOperationKey> = EventMap[(typeof BUS_OPERATIONS)[Op]['result'] & EventName] extends {
    response: infer R;
} ? R : void;
export type BusRequestErrorCode = 'bus.timeout' | 'bus.rejected' | 'bus.closed' | 'bus.bad-payload' | 'bus.unauthorized' | 'bus.forbidden' | 'bus.not-found' | 'bus.unsubscribed';
export declare class BusRequestError extends SemiontError {
    code: BusRequestErrorCode;
    constructor(message: string, code: BusRequestErrorCode, details?: Record<string, unknown>);
}
/**
 * The reply channels — result, failure, and (for streaming operations)
 * progress — of every operation in `channels`, deduplicated. Entries that
 * are not operation request channels (broadcast signals, domain events)
 * contribute nothing.
 *
 * This is THE derivation for a narrowed-subscription transport profile
 * (`HttpTransportConfig.channels`: subscribe exactly the reply channels of
 * the operations a process awaits) and for a service's outbound reply pump
 * (forward exactly the replies of the operations it answers). Restating a
 * reply channel by hand was the recurring unbridged-reply bug class.
 */
export declare function replyChannelsFor(channels: readonly string[]): EventName[];
/**
 * Subset of ITransport that `busRequest` needs: a way to send a command and
 * a way to observe channels. Generic enough that an in-process transport
 * can satisfy it without round-tripping through HTTP.
 */
export interface BusRequestPrimitive {
    /**
     * Matches `ITransport.emit`'s return: the subscriber count (`-1` =
     * unknown). `busRequest` itself ignores it — the reply channel is its
     * ack — but the primitive must stay assignable from every ITransport.
     */
    emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<number>;
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]>;
    /**
     * Connection state of the stream that carries replies. Required, not
     * optional (.plans/BUS-ATTACH-GATE.md D2): `busRequest` gates its emit on
     * this — no correlated emit before the reply path exists. Implementers back
     * it with a `BehaviorSubject`, so the current state arrives synchronously
     * on subscribe; a transport that cannot lose replies (in-process) reports
     * `'open'` until disposal.
     */
    state$: Observable<ConnectionState>;
    /**
     * Correlated-reply retention, client side (.plans/BUS-RESUMPTION.md
     * Phase 2 / SDK-DEBT S1). `busRequest` registers its correlationId here
     * BEFORE emitting and calls the returned disposer on every settle path;
     * a wire transport includes the currently-tracked ids as
     * `pendingReplies` in each subscribe body, so a reply published while
     * the connection was down is replayed from the server's retention
     * buffer on reconnect. OPTIONAL: an in-process transport that cannot
     * lose replies omits the surface and `busRequest` behaves as before.
     */
    trackReply?(correlationId: string): () => void;
    /**
     * Whether this transport's receive path delivers `channel` — i.e. a reply
     * published there can actually reach this process. Wire transports whose
     * subscription set is configurable (a worker subscribing only the reply
     * channels it awaits) implement this so `busRequest` on a channel outside
     * the set fails fast with `bus.unsubscribed` instead of burning its
     * timeout on a reply that could never arrive. OPTIONAL: an in-process
     * transport delivers every channel and omits it.
     */
    isSubscribed?(channel: string): boolean;
}
/**
 * Request/reply over the bus, keyed by the operation's request channel.
 *
 * The `operation` is a `BusOperationKey` (a request channel declared in
 * `BUS_OPERATIONS`); the matching `result`/`failure` reply channels are looked
 * up from the registry, so a caller cannot pass a mismatched or unbridged reply
 * pair — the recurring unbridged-reply bug class is unrepresentable. Every
 * registry reply derives into `BRIDGED_CHANNELS` (see bridged-channels.ts), so
 * the transport always subscribes to it (cf.
 * .plans/bugs/gather-resource-complete-not-bridged.md, where the `gather:resource-*`
 * pair shipped unbridged with no compile/runtime signal).
 *
 * The return type is INFERRED from the registry (`BusReply<Op>` = the result
 * channel's `response` type, or `void`) — callers never annotate it. Every reply
 * is `{ correlationId, response: T }` (data) or `{ correlationId }` (void); see
 * .plans/REPLY-SHAPE-STANDARD.md. `busRequest` reads `e.response`.
 */
export declare function busRequest<Op extends BusOperationKey>(bus: BusRequestPrimitive, operation: Op, payload: Record<string, unknown>, timeoutMs?: number): Promise<BusReply<Op>>;
