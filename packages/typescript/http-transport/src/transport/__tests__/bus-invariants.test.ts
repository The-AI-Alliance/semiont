/**
 * @semiont/http-transport channel-set invariants — the transport half of the
 * bus channel-classification contract (see @semiont/core's
 * src/__tests__/bus-invariants.test.ts for the full picture).
 *
 * `RESOURCE_SCOPED_CHANNELS` (generated into @semiont/core from the registry's
 * `audience: scoped`) is the per-resource set this transport subscribes to
 * *on top of* the global `BRIDGED_CHANNELS`. The two MUST be disjoint: a
 * channel in both is forwarded twice — once globally, once scoped — with
 * different SSE ids, defeating the client's event-id dedup. This is a runtime
 * relation between two declared lists, so the type system can't express it;
 * this test pins it.
 */

import { describe, it, expect } from 'vitest';
import { BRIDGED_CHANNELS, RESOURCE_SCOPED_CHANNELS } from '@semiont/core';

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
