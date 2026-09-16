/**
 * The channel-attribute classification (BUS-ROUTING-DECLARED P1).
 *
 * Three orthogonal, GENERATED attributes per channel — `recorded`,
 * `direction`, `delivery` — replacing the gateway's local partitions
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
import { BRIDGED_BROADCASTS, BRIDGED_CHANNELS } from '../bridged-channels';
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

  test('inbound ⇔ has a delivery value; outbound and in-process carry NONE — absence is a decision', () => {
    for (const ch of allChannels) {
      const a = attrs(ch);
      if (a.direction === 'inbound') {
        expect(['correlated', 'streaming', 'broadcast'], ch).toContain(a.delivery);
      } else {
        // Absent, not undefined-valued: a non-inbound channel must not carry
        // the key at all.
        expect('delivery' in a, `${ch} (${a.direction}) must not carry a delivery`).toBe(false);
      }
    }
  });

  test("the inbound set IS the fan-in set — direction:'inbound' ⇔ BRIDGED_CHANNELS", () => {
    const inbound = allChannels.filter((ch) => attrs(ch).direction === 'inbound').sort();
    expect(inbound).toEqual([...BRIDGED_CHANNELS].sort());
  });

  test('operations project correctly: request→outbound; result/failure→correlated; progress→streaming', () => {
    for (const [request, op] of Object.entries(BUS_OPERATIONS)) {
      expect(attrs(request).direction, request).toBe('outbound');
      expect(attrs(op.result).delivery, op.result).toBe('correlated');
      expect(attrs(op.failure).delivery, op.failure).toBe('correlated');
      if ('progress' in op && op.progress) {
        expect(attrs(op.progress).delivery, op.progress).toBe('streaming');
      }
    }
  });

  test('bridged broadcasts are inbound broadcast', () => {
    for (const ch of BRIDGED_BROADCASTS) {
      expect(attrs(ch).direction, ch).toBe('inbound');
      expect(attrs(ch).delivery, ch).toBe('broadcast');
    }
  });

  test('recorded ⇔ persisted — the attribute mirrors PERSISTED_EVENT_TYPES exactly', () => {
    const persisted = new Set<string>(PERSISTED_EVENT_TYPES);
    for (const ch of allChannels) {
      expect(attrs(ch).recorded, ch).toBe(persisted.has(ch));
    }
  });

  test('recorded and delivery are independent — pinned by the six channels that are both', () => {
    // The six persisted∧broadcast channels, pinned BY NAME so a later reader
    // cannot "fix" the overlap away: recorded and delivered are two true
    // facts about one channel, not a conflict (BUS-ROUTING-DECLARED D3).
    const both = allChannels
      .filter((ch) => attrs(ch).recorded && attrs(ch).delivery === 'broadcast')
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
