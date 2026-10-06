/**
 * Per-service transport channel sets — the narrowed SSE subscription of each
 * make-meaning service.
 *
 * Each service's HttpTransport subscribes exactly what it consumes: the
 * smelter and weaver the reply channels of the operations they await, the
 * librarian its inbound request/signal roster with the reply channels of the
 * one read it awaits. These pins
 * are census gates: grow a roster (or add a `busRequest` call site) and the
 * exact-set assertion fails, forcing the subscription change to be
 * acknowledged here rather than drifting silently. The runtime backstop is
 * `busRequest`'s `isSubscribed` probe — an awaited operation missing from
 * its service's set fails immediately with `bus.unsubscribed`.
 */

import { describe, it, expect } from 'vitest';
import { BRIDGED_CHANNELS, BUS_OPERATIONS } from '@semiont/core';
import {
  SMELTER_REPLY_CHANNELS,
  WEAVER_REPLY_CHANNELS,
  LIBRARIAN_INBOUND_CHANNELS,
  LIBRARIAN_OUTBOUND_CHANNELS,
} from '../service-channels';

describe('smelter transport channels', () => {
  it('carries exactly the reply channels of the operations the Smelter awaits', () => {
    expect([...SMELTER_REPLY_CHANNELS].sort()).toEqual([
      'browse:annotations-failed',
      'browse:annotations-result',
      'browse:resource-failed',
      'browse:resource-result',
      'browse:resources-failed',
      'browse:resources-result',
    ]);
  });

  it('every channel is a bridged reply channel — the derivation cannot drift from the registry', () => {
    for (const channel of SMELTER_REPLY_CHANNELS) {
      expect(BRIDGED_CHANNELS).toContain(channel);
    }
  });
});

describe('weaver transport channels', () => {
  it('carries exactly the reply channels of the operations the Weaver awaits', () => {
    expect([...WEAVER_REPLY_CHANNELS].sort()).toEqual([
      'browse:annotations-failed',
      'browse:annotations-result',
      'browse:events-failed',
      'browse:events-result',
      'browse:resources-failed',
      'browse:resources-result',
    ]);
  });

  it('every channel is a bridged reply channel — the derivation cannot drift from the registry', () => {
    for (const channel of WEAVER_REPLY_CHANNELS) {
      expect(BRIDGED_CHANNELS).toContain(channel);
    }
  });
});

describe('librarian transport channels', () => {
  it('subscribes exactly its inbound roster', () => {
    expect([...LIBRARIAN_INBOUND_CHANNELS].sort()).toEqual([
      // Its actors' model limits: the librarian holds the gatherer's and the
      // matcher's inference credentials, so only it can discover them.
      'gather:limits-requested',
      // What refers to a resource: an inbound-edge query on the graph.
      'gather:referenced-by-requested',
      'gather:requested',
      'gather:resource-requested',
      'gather:summary-requested',
      'match:limits-requested',
      // Searching resources by text: the graph, then the vectors.
      'match:resources-requested',
      'match:search-requested',
      'smelt:settled',
      'weave:applied',
    ]);
  });

  it('subscribes no operation reply channel — never the global reply fan-out', () => {
    for (const op of Object.values(BUS_OPERATIONS)) {
      expect(LIBRARIAN_INBOUND_CHANNELS).not.toContain(op.result);
      expect(LIBRARIAN_INBOUND_CHANNELS).not.toContain(op.failure);
    }
  });

  it('nothing echoes: the outbound reply pump and the inbound subscription are disjoint', () => {
    for (const channel of LIBRARIAN_OUTBOUND_CHANNELS) {
      expect(LIBRARIAN_INBOUND_CHANNELS).not.toContain(channel);
    }
  });
});
