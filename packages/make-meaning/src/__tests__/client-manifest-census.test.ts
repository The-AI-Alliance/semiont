/**
 * RED (CLIENT-SUBSCRIPTION-MANIFEST P2, D2/D3): each sidecar declares ONE
 * manifest, and it covers everything that sidecar consumes.
 *
 * The defect this gate exists for, found 2026-09-16 while writing P2: both
 * sidecar state units build their streams AT CONSTRUCTION
 * (`SMELTER_CHANNELS.map((c) => bus.stream(c))`) but widened the subscription
 * set later, in `start()`, via `addChannels`. The set and the consumption
 * were therefore never comparable at any single moment — which is exactly
 * how a widening can be deleted without any list getting shorter (the
 * 2026-09-16 worker outage), and how P1's `stream` refusal would reject
 * `yield:created` at weaver boot: not in the constructed reply set, and not
 * scopable because it is globally bridged.
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
} from '../smelter-actor-state-unit';
import {
  WEAVER_MANIFEST,
  WEAVER_CHANNELS,
  WEAVER_COMMAND_CHANNELS,
} from '../weaver-actor-state-unit';
import { SMELTER_REPLY_CHANNELS, WEAVER_REPLY_CHANNELS } from '../service-channels';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const CLIENTS = [
  {
    kind: 'smelter',
    manifest: SMELTER_MANIFEST,
    consumed: [...SMELTER_CHANNELS, ...SMELTER_COMMAND_CHANNELS, ...SMELTER_REPLY_CHANNELS],
    unit: 'smelter-actor-state-unit.ts',
    main: 'smelter-main.ts',
  },
  {
    kind: 'weaver',
    manifest: WEAVER_MANIFEST,
    consumed: [...WEAVER_CHANNELS, ...WEAVER_COMMAND_CHANNELS, ...WEAVER_REPLY_CHANNELS],
    unit: 'weaver-actor-state-unit.ts',
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

  it.each(CLIENTS)('$kind: the state unit does not widen after construction', (client) => {
    // The widening verb is what let declaration and consumption drift apart.
    // With the whole manifest at construction there is nothing left to widen,
    // and `stream()` at construction is inside the set by definition.
    const source = stripComments(readFileSync(join(SRC, client.unit), 'utf-8'));
    expect(source, `${client.unit} still widens its subscription set`).not.toMatch(/addChannels/);
  });

  it.each(CLIENTS)('$kind: main constructs the transport with the manifest', (client) => {
    const source = stripComments(readFileSync(join(SRC, client.main), 'utf-8'));
    const manifestName = client.kind === 'smelter' ? 'SMELTER_MANIFEST' : 'WEAVER_MANIFEST';
    expect(source, `${client.main} must pass ${manifestName} as its channel set`).toMatch(
      new RegExp(`channels:\\s*${manifestName}`),
    );
  });
});
