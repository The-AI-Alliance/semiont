/**
 * The boot property P1's refusal made load-bearing: a sidecar's manifest must
 * cover every channel its fold streams AT CONSTRUCTION.
 *
 * Measured 2026-09-16, before P2: the weaver would have thrown
 * `bus.unsubscribed` on `yield:created`, `frame:entity-type-added` and
 * `weave:rebuild` at `createWeaverActorStateUnit`, and the smelter on
 * `yield:created`, `yield:updated` and `smelt:rebuild-anchors` — because the
 * transport was constructed with reply channels only and widened later. The
 * sidecar suites could not see it: their doubles answer every channel.
 *
 * This asserts against the REAL refusal rule (global set, or scopable), not
 * against a double.
 */
import { describe, it, expect } from 'vitest';
import { RESOURCE_SCOPED_CHANNELS } from '@semiont/core';
import { SMELTER_MANIFEST, SMELTER_CHANNELS, SMELTER_COMMAND_CHANNELS } from '../smelter-actor-state-unit';
import { WEAVER_MANIFEST, WEAVER_CHANNELS, WEAVER_COMMAND_CHANNELS } from '../weaver-actor-state-unit';

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
