import { SemiontError } from './errors';
import type { EventMap, EventName } from './bus-protocol';
import { BUS_OPERATIONS, type BusOperationKey } from './bus-operations';
import type { CommandErrorCode } from './payload-types';
import { busRequestCodeByWireCode, unrecognizedFailureCode, type BusRequestErrorCode } from './generated/error-codes';

/**
 * The value a registered operation resolves to: the `response` field of its
 * result channel's payload, or `void` for a result channel that carries no
 * `response` (a confirmed-write ack with no data). Inferred from the registry,
 * so callers never annotate `Bus.request`'s return type. Relies on the reply-shape
 * standard.
 */
export type BusReply<Op extends BusOperationKey> =
  EventMap[(typeof BUS_OPERATIONS)[Op]['result'] & EventName] extends { response: infer R }
    ? R
    : void;

/**
 * What a failed `Bus.request` can tell its caller: `BusRequestErrorCode`,
 * generated from specs/src/errors/codes.json, where each member is documented.
 *
 * Two kinds of member, and the split is the point. `bus.not-found`,
 * `bus.peer-unavailable`, `bus.unauthorized` and `bus.none-pending` are facts
 * the PEER stated, promoted from `CommandError.code` by the table's `wire`
 * entries. The rest are facts only this side knows — a timeout, a closed
 * connection, a local misconfiguration — which is why the two vocabularies stay
 * separate rather than collapsing into one.
 *
 * There is no `bus.bad-payload` or `bus.forbidden`: nothing produces either,
 * and the HTTP-shaped facts they would name live in `TransportErrorCode` with
 * a real producer (`transportErrorCodeForStatus`). A member nothing can emit
 * promises a distinction the system cannot make. `bus.unauthorized` is a
 * member because it has a producer: the dispatcher refusing a `job:claim`
 * from a caller without the worker role.
 *
 * The mapping has one site, the table. Left unmapped, a consumer would reach
 * into `details.payload.code` and there would be two ways to ask the same
 * question. The generator refuses a table that leaves a wire code unmapped, and
 * `satisfies` repeats that here against the generated `CommandErrorCode`, so a
 * stale generated file fails to compile rather than defaulting to
 * `bus.rejected`.
 */
const WIRE_CODES = new Map<unknown, BusRequestErrorCode>(
  Object.entries(busRequestCodeByWireCode satisfies Record<CommandErrorCode, BusRequestErrorCode>),
);

/**
 * Read as `unknown`, because that is what crosses the boundary: the value comes
 * from a peer that may be newer than this build. An unrecognized code degrades
 * to the table's `unrecognizedFailure` rather than being trusted through —
 * inventing a `BusRequestErrorCode` nobody handles is worse than the honest
 * fallback.
 */
export function classifyFailureCode(code: unknown): BusRequestErrorCode {
  return WIRE_CODES.get(code) ?? unrecognizedFailureCode;
}

export class BusRequestError extends SemiontError {
  declare code: BusRequestErrorCode;

  constructor(message: string, code: BusRequestErrorCode, details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'BusRequestError';
  }
}

/**
 * The reply channels — result and failure — of every operation in
 * `channels`, deduplicated. Entries that are not operation request channels
 * (broadcast signals, domain events) contribute nothing.
 *
 * This is THE derivation for a narrowed-subscription transport profile
 * (`HttpTransportConfig.channels`: subscribe exactly the reply channels of
 * the operations a process awaits) and for a service's outbound reply pump
 * (forward exactly the replies of the operations it answers). Restating a
 * reply channel by hand is the unbridged-reply bug class.
 */
export function replyChannelsFor(channels: readonly string[]): EventName[] {
  const out = new Set<EventName>();
  for (const ch of channels) {
    const op = BUS_OPERATIONS[ch as BusOperationKey];
    if (!op) continue;
    out.add(op.result);
    out.add(op.failure);
  }
  return [...out];
}
