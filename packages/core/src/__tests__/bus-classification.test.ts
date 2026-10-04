/**
 * The channel-attribute classification.
 *
 * Orthogonal, GENERATED attributes per channel — `recorded`, `direction`,
 * `writes`, `delivery` — replacing the gateway's local partitions
 * (`CORRELATED_CHANNELS`, `PROGRESS_CHANNELS`) and the branches that read
 * them. This suite does NOT re-derive from `registry.json` (that would be a
 * second copy of the generator's derivation); it cross-checks the generated
 * classification against the OTHER generated authorities of the same
 * registry — `BUS_OPERATIONS`, `BRIDGED_BROADCASTS`, `CHANNEL_SCHEMAS`,
 * `PERSISTED_EVENT_TYPES`. Two independent projections of one source must
 * agree; where they cannot, the registry itself is corrupt.
 *
 * The growth gate is structural: a new operation regenerates every authority,
 * and these assertions iterate them — no hand edit here, ever. Staleness
 * (generated files out of date with the registry) is the generator's
 * `--check` drift gate's job, not this suite's.
 */
import { describe, test, expect } from 'vitest';
import { CHANNEL_ATTRS, channelAttrsOf } from '../bus-classification';
import { CHANNEL_SCHEMAS } from '../bus-protocol';
import { BUS_OPERATIONS } from '../bus-operations';
import { BRIDGED_BROADCASTS, BRIDGED_CHANNELS, RESOURCE_SCOPED_CHANNELS } from '../bridged-channels';
import { PERSISTED_EVENT_TYPES } from '../persisted-events';

const allChannels = Object.keys(CHANNEL_SCHEMAS);
const attrs = (ch: string) => {
  const a = channelAttrsOf(ch);
  if (!a) throw new Error(`no attrs for ${ch}`);
  return a;
};

describe('channel classification (generated)', () => {
  test('every channel is classified; the accessor agrees with the map', () => {
    for (const ch of allChannels) {
      expect(channelAttrsOf(ch), ch).toBeDefined();
    }
    expect(Object.keys(CHANNEL_ATTRS).sort()).toEqual([...allChannels].sort());
    expect(channelAttrsOf('no:such-channel')).toBeUndefined();
  });

  test('every channel that crosses the wire has a delivery class, and only those', () => {
    // The class is what a subscriber is promised about a frame when its
    // stream drops or is handed over. A channel that never crosses has no
    // stream to drop, so the key is absent, not undefined-valued.
    for (const ch of allChannels) {
      const a = attrs(ch);
      expect('delivery' in a, `${ch} (${a.direction})`).toBe(a.direction !== 'in-process');
    }
  });

  test('a delivery class follows from the other axes: replies are correlated, a recorded event on a scope is positioned, the rest pass', () => {
    const replyChannels = new Set<string>();
    for (const op of Object.values(BUS_OPERATIONS)) {
      replyChannels.add(op.result);
      replyChannels.add(op.failure);
    }
    const scoped = new Set<string>(RESOURCE_SCOPED_CHANNELS);
    for (const ch of allChannels) {
      const a = attrs(ch);
      if (a.direction === 'in-process') continue;
      const expected = replyChannels.has(ch) ? 'correlated' : a.recorded && scoped.has(ch) ? 'positioned' : 'passing';
      expect(a.delivery, ch).toBe(expected);
    }
  });

  test('a recorded event has a position only when it is delivered on a scope — pinned by the six that are not', () => {
    // Recorded, and heard by every client on no scope: nothing replays these
    // to a client whose stream was down. A client asks again for what they
    // feed when its stream reopens (specs/src/client/refresh.json, `reopened`).
    const passingAndBridged = allChannels.filter(
      (ch) => attrs(ch).recorded && attrs(ch).delivery === 'passing' && (BRIDGED_CHANNELS as readonly string[]).includes(ch),
    );
    expect(passingAndBridged.sort()).toEqual([
      'frame:entity-type-added',
      'frame:tag-schema-added',
      'yield:cloned',
      'yield:created',
      'yield:moved',
      'yield:updated',
    ]);
  });

  test('BRIDGED_CHANNELS is the replies plus audience:everyone — not every inbound channel', () => {
    // Restated when the registry gained its audience axis. `inbound` now
    // covers three audiences: everyone, scoped (joined per resource) and
    // declared (named in a client manifest). Only the first auto-subscribes,
    // so the old biconditional would now demand that every browser subscribe
    // the worker's channels.
    const inbound = new Set(allChannels.filter((ch) => attrs(ch).direction === 'inbound'));
    for (const ch of BRIDGED_CHANNELS) {
      expect(inbound.has(ch), `${ch} is bridged but not inbound`).toBe(true);
    }
    const scopedOrDeclared = [...inbound].filter((ch) => !(BRIDGED_CHANNELS as readonly string[]).includes(ch));
    expect(
      scopedOrDeclared.length,
      'inbound must be strictly larger than the auto-subscribe set once scoped/declared exist',
    ).toBeGreaterThan(0);
  });

  test('operations project correctly: request→outbound and passing; result/failure→correlated', () => {
    for (const [request, op] of Object.entries(BUS_OPERATIONS)) {
      expect(attrs(request).direction, request).toBe('outbound');
      expect(attrs(request).delivery, request).toBe('passing');
      expect(attrs(op.result).delivery, op.result).toBe('correlated');
      expect(attrs(op.failure).delivery, op.failure).toBe('correlated');
    }
  });

  test('bridged broadcasts are inbound, and every one of them passes', () => {
    // WHO receives a frame is the audience axis, which BRIDGED_BROADCASTS is
    // the projection of. What each receiver is promised is the delivery
    // class: a broadcast has no scope to hold a position in and answers no
    // request, so nothing replays it.
    for (const ch of BRIDGED_BROADCASTS) {
      expect(attrs(ch).direction, ch).toBe('inbound');
      expect(attrs(ch).delivery, ch).toBe('passing');
    }
  });

  test('recorded ⇔ persisted — the attribute mirrors PERSISTED_EVENT_TYPES exactly', () => {
    const persisted = new Set<string>(PERSISTED_EVENT_TYPES);
    for (const ch of allChannels) {
      expect(attrs(ch).recorded, ch).toBe(persisted.has(ch));
    }
  });

  test('recorded and audience are independent — pinned by the six channels that are both', () => {
    // The six persisted AND auto-subscribed channels, pinned BY NAME so a
    // later reader cannot "fix" the overlap away: recorded and delivered are
    // two true facts about one channel, not a conflict. Expressed on the
    // audience axis, which states who receives a channel; `delivery` has no
    // 'broadcast' value restating it.
    const everyone = new Set<string>(BRIDGED_BROADCASTS);
    const both = allChannels
      .filter((ch) => attrs(ch).recorded && everyone.has(ch))
      .sort();
    expect(both).toEqual([
      'frame:entity-type-added',
      'frame:tag-schema-added',
      'yield:cloned',
      'yield:created',
      'yield:moved',
      'yield:updated',
    ]);
  });
});
