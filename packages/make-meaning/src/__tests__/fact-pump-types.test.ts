/**
 * The fact pump carries typed events (DOMAIN-EVENT-PATH-TYPED P2).
 *
 * `archivist-main` hands the pump a correctly-typed merge of every persisted
 * channel. The pump used to widen it back to `StoredEvent` at its own
 * parameter, then cast its way out — `as keyof EventMap` to name the channel
 * and `as never` to hand over the payload. The erasure was self-inflicted.
 */

import { describe, it, expect } from 'vitest';
import type { Observable } from 'rxjs';
import type { EventMap, PersistedEventType } from '@semiont/core';
import { createFactPump } from '../fact-pump';

/**
 * Equality, not assignability: a typed stream is already assignable to an
 * erased one, so `extends` would have passed against the very code this
 * phase replaces.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

describe('the fact pump does not erase what it is given', () => {
  it('takes the merged persisted-channel stream, not a widened one', () => {
    const exact: Equals<
      Parameters<typeof createFactPump>[0],
      Observable<EventMap[PersistedEventType]>
    > = true;
    expect(exact).toBe(true);
  });

  it('rejects a stream of something that is not a persisted fact', () => {
    // Asserted in the type system, not by calling: a `@ts-expect-error` on a
    // real call still runs the call under vitest.
    type Accepted<T> = Observable<T> extends Parameters<typeof createFactPump>[0] ? true : false;
    const rejected: Accepted<{ nope: true }> = false;
    expect(rejected).toBe(false);
  });
});
