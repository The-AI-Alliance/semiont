/**
 * @semiont/http-transport channel-set invariants — the transport half of the
 * bus channel-classification contract (see @semiont/core's
 * src/__tests__/bus-invariants.test.ts for the full picture).
 *
 * `RESOURCE_SCOPED_CHANNELS` is the per-resource (scoped) set this transport
 * subscribes to *on top of* the global `BRIDGED_CHANNELS`. The two MUST be
 * disjoint: a channel in both is forwarded twice — once globally, once scoped —
 * with different SSE ids, defeating the client's event-id dedup
 * (.plans/bugs/BRIDGE-GAPS.md, Fix #2). This is a runtime relation between two
 * arrays, so the type system can't express it; the derivation
 * (`PERSISTED_EVENT_TYPES.filter(t => !BRIDGED_CHANNELS.includes(t))`) is meant
 * to guarantee it, and this test pins that the guarantee actually holds.
 */

import { describe, it, expect } from 'vitest';
import { BRIDGED_CHANNELS } from '@semiont/core';
import { RESOURCE_SCOPED_CHANNELS } from '../http-transport';

describe('http-transport channel-set invariants', () => {
  it('BRIDGED_CHANNELS and RESOURCE_SCOPED_CHANNELS are disjoint', () => {
    const bridged = new Set<string>(BRIDGED_CHANNELS);
    const overlap = RESOURCE_SCOPED_CHANNELS.filter((c) => bridged.has(c));
    expect(overlap).toEqual([]);
  });

  it('RESOURCE_SCOPED_CHANNELS has no duplicate entries', () => {
    const dups = RESOURCE_SCOPED_CHANNELS.filter(
      (c, i) => RESOURCE_SCOPED_CHANNELS.indexOf(c) !== i,
    );
    expect(dups).toEqual([]);
  });
});
