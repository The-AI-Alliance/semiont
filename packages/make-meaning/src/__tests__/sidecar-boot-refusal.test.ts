/**
 * The boot property `stream()` makes load-bearing by refusing a channel
 * outside the subscription set: a sidecar's manifest must cover every channel
 * its fold streams AT CONSTRUCTION.
 *
 * A transport constructed with reply channels only, and widened later, throws
 * `bus.unsubscribed` at the fan-in: the weaver on `yield:created`,
 * `frame:entity-type-added` and `weave:rebuild`, the smelter on
 * `yield:created`, `yield:updated` and `smelt:rebuild-anchors`. The sidecar
 * suites cannot see it: their doubles answer every channel.
 *
 * This asserts against the REAL refusal rule (global set, or scopable), not
 * against a double.
 */
import { describe, it, expect } from 'vitest';
import { RESOURCE_SCOPED_CHANNELS } from '@semiont/core';
import { SMELTER_MANIFEST, SMELTER_CHANNELS, SMELTER_COMMAND_CHANNELS } from '../smelter-fan-in';
import { WEAVER_MANIFEST, WEAVER_CHANNELS, WEAVER_COMMAND_CHANNELS } from '../weaver-fan-in';

const scopable = new Set<string>(RESOURCE_SCOPED_CHANNELS);

describe('sidecar boot survives the stream refusal', () => {
  it.each([
    { kind: 'smelter', manifest: SMELTER_MANIFEST, streamed: [...SMELTER_CHANNELS, ...SMELTER_COMMAND_CHANNELS] },
    { kind: 'weaver', manifest: WEAVER_MANIFEST, streamed: [...WEAVER_CHANNELS, ...WEAVER_COMMAND_CHANNELS] },
  ])('$kind: no channel streamed at construction is refused', ({ kind, manifest, streamed }) => {
    const global = new Set<string>(manifest);
    const refused = streamed.filter((c) => !global.has(c) && !scopable.has(c));
    expect(refused, `${kind} would throw bus.unsubscribed at construction`).toEqual([]);
  });
});
