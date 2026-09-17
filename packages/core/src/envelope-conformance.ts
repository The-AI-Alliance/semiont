/**
 * One conformance check, for every relay that stands between an emitter and a
 * handler: **does the frame's envelope survive the hop?**
 *
 * This exists because the hole it closes is invisible to the compiler.
 * `BusRequestPrimitive.emit` and `ITransport.emit` both declare a third
 * `envelope` parameter, and TypeScript accepts an implementation that declares
 * only two — a function of fewer parameters is assignable to one of more. Three
 * separate in-process implementations were written that way. Each typechecked,
 * each delivered every payload, and each silently dropped the correlation key
 * that `busRequest` matches its reply on, so every request behind them hung
 * until its timeout with no error anywhere. The gate is a runtime one because
 * the defect is a runtime one.
 *
 * Call it from the package that OWNS the implementation, against a real
 * instance, so the gate moves with the code it guards.
 */
import type { EventMap } from './bus-protocol';
import type { BusEnvelope } from './event-bus';

/** The narrow shape this check needs — satisfied by `BusRequestPrimitive`,
 *  `ITransport`, and anything else that relays frames. */
export interface EnvelopeRelay {
  emit(channel: never, payload: never, envelope?: BusEnvelope): unknown;
}

export interface EnvelopeConformanceSpec {
  /** A relay to exercise. */
  relay: EnvelopeRelay;
  /** Observe the frame the relay produced, however it is reached. Return the
   *  correlationId it carried, or `undefined` if none arrived. May be async. */
  observe(): Promise<string | undefined> | string | undefined;
  /** A channel the relay will accept. */
  channel: keyof EventMap;
  /** A payload valid for `channel`. */
  payload: unknown;
}

/**
 * Emit through the relay under a known key and assert the key came out the
 * other side. Throws with a message naming the failure mode, so a suite that
 * calls this reads its own diagnosis.
 */
export async function assertCarriesEnvelope(spec: EnvelopeConformanceSpec): Promise<void> {
  const correlationId = `envelope-conformance-${Math.random().toString(36).slice(2)}`;
  await (spec.relay.emit as (c: unknown, p: unknown, e?: BusEnvelope) => unknown)(
    spec.channel,
    spec.payload,
    { correlationId },
  );
  const seen = await spec.observe();
  if (seen !== correlationId) {
    throw new Error(
      `envelope conformance: emitted ${String(spec.channel)} with correlationId=${correlationId}, ` +
        `but the frame that arrived carried ${seen === undefined ? 'none' : seen}. ` +
        `A relay whose \`emit\` declares fewer parameters than the interface still ` +
        `typechecks — and drops the key every awaiting request matches its reply on.`,
    );
  }
}
