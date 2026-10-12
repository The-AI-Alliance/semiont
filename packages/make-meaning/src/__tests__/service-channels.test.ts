/**
 * The Librarian's transport channel set — its narrowed SSE subscription.
 *
 * Its HttpTransport subscribes exactly what it consumes: its inbound
 * request/signal roster and no reply channel, since it awaits no operation.
 * These pins are census gates: grow the roster and the exact-set assertion
 * fails, forcing the subscription change to be acknowledged here rather than
 * drifting silently. The runtime backstop is `busRequest`'s `isSubscribed`
 * probe — an operation awaited over a transport that carries no reply channel
 * for it fails immediately with `bus.unsubscribed`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BUS_OPERATIONS } from '@semiont/core';
import {
  LIBRARIAN_INBOUND_CHANNELS,
  LIBRARIAN_OUTBOUND_CHANNELS,
} from '../service-channels';

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

  it('main constructs the transport with the inbound roster alone', () => {
    // The Librarian awaits no reply over the bus, so nothing is spread in
    // beside its roster: a reply channel added there is an await to account
    // for here.
    const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'librarian-main.ts');
    const source = readFileSync(main, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(source).toMatch(/channels:\s*LIBRARIAN_INBOUND_CHANNELS\s*,/);
  });

  it('nothing echoes: the outbound reply pump and the inbound subscription are disjoint', () => {
    for (const channel of LIBRARIAN_OUTBOUND_CHANNELS) {
      expect(LIBRARIAN_INBOUND_CHANNELS).not.toContain(channel);
    }
  });
});
