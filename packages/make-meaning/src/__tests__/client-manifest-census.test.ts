/**
 * Each sidecar declares ONE manifest, and it covers everything that sidecar
 * consumes.
 *
 * What this gate exists for: both sidecar fan-ins ask the bus for their
 * streams the moment they are called
 * (`SMELTER_CHANNELS.map((c) => bus.stream(c))`). A subscription set widened
 * afterwards, via an `addChannels`, is never comparable with the consumption
 * at any single moment — which is how a widening can be deleted without any
 * list getting shorter, and how `stream`'s refusal of a channel outside the
 * subscription set would reject `yield:created` at weaver boot: not in the
 * constructed reply set, and not scopable because it is globally bridged.
 *
 * The manifest is the whole set, stated once, and the transport is
 * constructed with it. Then consumption cannot outrun declaration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  SMELTER_MANIFEST,
  SMELTER_CHANNELS,
  SMELTER_COMMAND_CHANNELS,
} from '../smelter-fan-in';
import {
  WEAVER_MANIFEST,
  WEAVER_CHANNELS,
  WEAVER_COMMAND_CHANNELS,
} from '../weaver-fan-in';
import { SMELTER_REPLY_CHANNELS, WEAVER_REPLY_CHANNELS } from '../service-channels';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const CLIENTS = [
  {
    kind: 'smelter',
    manifest: SMELTER_MANIFEST,
    consumed: [...SMELTER_CHANNELS, ...SMELTER_COMMAND_CHANNELS, ...SMELTER_REPLY_CHANNELS],
    fanIn: 'smelter-fan-in.ts',
    main: 'smelter-main.ts',
  },
  {
    kind: 'weaver',
    manifest: WEAVER_MANIFEST,
    consumed: [...WEAVER_CHANNELS, ...WEAVER_COMMAND_CHANNELS, ...WEAVER_REPLY_CHANNELS],
    fanIn: 'weaver-fan-in.ts',
    main: 'weaver-main.ts',
  },
] as const;

describe('client subscription manifests (sidecars)', () => {
  it.each(CLIENTS)('$kind: the manifest covers everything the client consumes', (client) => {
    const manifest = new Set<string>(client.manifest);
    const missing = client.consumed.filter((c) => !manifest.has(c));
    expect(missing, `${client.kind} consumes channels its manifest does not declare`).toEqual([]);
  });

  it.each(CLIENTS)('$kind: every manifest entry has a consumer — no dead widenings', (client) => {
    const consumed = new Set<string>(client.consumed);
    const dead = [...client.manifest].filter((c) => !consumed.has(c));
    expect(dead, `${client.kind} declares channels nothing consumes`).toEqual([]);
  });

  it.each(CLIENTS)('$kind: the fan-in does not widen the subscription set', (client) => {
    // A widening verb is what lets declaration and consumption drift apart.
    // With the whole manifest at construction there is nothing to widen,
    // and the fan-in's `stream()` calls are inside the set by definition.
    const source = stripComments(readFileSync(join(SRC, client.fanIn), 'utf-8'));
    expect(source, `${client.fanIn} still widens its subscription set`).not.toMatch(/addChannels/);
  });

  it.each(CLIENTS)('$kind: main constructs the transport with the manifest', (client) => {
    const source = stripComments(readFileSync(join(SRC, client.main), 'utf-8'));
    const manifestName = client.kind === 'smelter' ? 'SMELTER_MANIFEST' : 'WEAVER_MANIFEST';
    expect(source, `${client.main} must pass ${manifestName} as its channel set`).toMatch(
      new RegExp(`channels:\\s*${manifestName}`),
    );
  });
});
