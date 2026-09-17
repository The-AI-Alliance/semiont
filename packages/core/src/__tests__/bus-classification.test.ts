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

  test('delivery belongs to OPERATION replies alone — every other channel carries none', () => {
    // Restated at WIRE-CROSSING-MODEL P1. It used to read "inbound iff has a
    // delivery value", which held only while `broadcast` was a delivery — and
    // `broadcast` restated `audience: everyone`, one fact in two places with
    // no consumer, and `streaming` had one declared member that nothing ever
    // emitted. Delivery now answers how a REPLY is matched to its request;
    // who receives a frame is the audience axis.
    const replyChannels = new Set<string>();
    for (const op of Object.values(BUS_OPERATIONS)) {
      replyChannels.add(op.result);
      replyChannels.add(op.failure);
    }
    for (const ch of allChannels) {
      const a = attrs(ch);
      if (replyChannels.has(ch)) {
        expect(a.delivery, ch).toBe('correlated');
      } else {
        // Absent, not undefined-valued: the key must not be there at all.
        expect('delivery' in a, `${ch} (${a.direction}) must not carry a delivery`).toBe(false);
      }
    }
  });

  test('BRIDGED_CHANNELS is the replies plus audience:everyone — not every inbound channel', () => {
    // Also restated at P1. `inbound` now covers three audiences: everyone,
    // scoped (joined per resource) and declared (named in a client manifest).
    // Only the first auto-subscribes, so the old biconditional would now
    // demand that every browser subscribe the worker's channels.
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

  test('operations project correctly: request→outbound; result/failure→correlated; progress→streaming', () => {
    for (const [request, op] of Object.entries(BUS_OPERATIONS)) {
      expect(attrs(request).direction, request).toBe('outbound');
      expect(attrs(op.result).delivery, op.result).toBe('correlated');
      expect(attrs(op.failure).delivery, op.failure).toBe('correlated');
    }
  });

  test('bridged broadcasts are inbound, and carry no delivery of their own', () => {
    // They used to assert delivery:'broadcast'. That value restated
    // `audience: everyone` and had no consumer, so P1 removed it: an
    // auto-subscribed event is inbound, and WHO receives it is the audience
    // axis, which BRIDGED_BROADCASTS is itself the projection of.
    for (const ch of BRIDGED_BROADCASTS) {
      expect(attrs(ch).direction, ch).toBe('inbound');
      expect('delivery' in attrs(ch), `${ch} must not carry a delivery`).toBe(false);
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
    // two true facts about one channel, not a conflict (BUS-ROUTING-DECLARED
    // D3). Expressed on the audience axis now that P1 removed the
    // delivery:'broadcast' restatement of it.
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
