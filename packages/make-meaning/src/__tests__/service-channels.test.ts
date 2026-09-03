/**
 * Per-service transport channel sets (narrowed SSE subscription — the
 * worker-OOM fix, 2026-09-03, extended to the make-meaning services).
 *
 * Each service's HttpTransport subscribes exactly what it consumes: the
 * smelter and weaver the reply channels of the operations they await, the
 * librarian and archivist their inbound request/signal rosters. These pins
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
  ARCHIVIST_INBOUND_CHANNELS,
  ARCHIVIST_OUTBOUND_CHANNELS,
  ARCHIVIST_OUTBOUND_STRAYS,
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
      'gather:requested',
      'gather:resource-requested',
      'gather:summary-requested',
      'match:search-requested',
      'smelt:settled',
      'weave:applied',
    ]);
  });

  it('subscribes no operation reply channel — the global reply fan-out that OOMed the worker', () => {
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

describe('archivist transport channels', () => {
  it('subscribes exactly its inbound roster', () => {
    expect([...ARCHIVIST_INBOUND_CHANNELS].sort()).toEqual([
      'browse:agents-requested',
      'browse:anchored-text-by-checksum-requested',
      'browse:anchored-text-requested',
      'browse:annotation-context-requested',
      'browse:annotation-history-requested',
      'browse:annotation-requested',
      'browse:annotations-requested',
      'browse:directory-requested',
      'browse:entity-types-requested',
      'browse:events-requested',
      'browse:referenced-by-requested',
      'browse:resource-requested',
      'browse:resources-requested',
      'browse:tag-schemas-requested',
      'frame:add-entity-type',
      'frame:add-tag-schema',
      'job:complete',
      'job:fail',
      'job:start',
      'mark:archive',
      'mark:create',
      'mark:create-request',
      'mark:delete',
      'mark:unarchive',
      'mark:update-body',
      'mark:update-entity-types',
      'smelt:settled',
      'yield:clone-create',
      'yield:clone-persist',
      'yield:clone-resource-requested',
      'yield:clone-token-requested',
      'yield:create',
      'yield:mv',
      'yield:update',
    ]);
  });

  it('subscribes no operation reply channel — the global reply fan-out that OOMed the worker', () => {
    for (const op of Object.values(BUS_OPERATIONS)) {
      expect(ARCHIVIST_INBOUND_CHANNELS).not.toContain(op.result);
      expect(ARCHIVIST_INBOUND_CHANNELS).not.toContain(op.failure);
    }
  });

  it('nothing echoes: the outbound reply pump and the inbound subscription are disjoint', () => {
    for (const channel of ARCHIVIST_OUTBOUND_CHANNELS) {
      expect(ARCHIVIST_INBOUND_CHANNELS).not.toContain(channel);
    }
  });

  it('the outbound pump carries the strays — replies whose operation is keyed under a gateway handler channel', () => {
    for (const stray of ARCHIVIST_OUTBOUND_STRAYS) {
      expect(ARCHIVIST_OUTBOUND_CHANNELS).toContain(stray);
    }
  });
});
