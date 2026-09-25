/**
 * BUS-CARRIES-FRAMES P4 — the other half of the payload census.
 *
 * `correlation-not-in-payload-types.test.ts` makes the TYPED form of the
 * regression impossible: no `EventMap[K]` declares `correlationId`, so
 * `event.correlationId` in a handler is a compile error. This census covers
 * what that one structurally cannot see — reaching the key where no payload
 * type is consulted at all.
 *
 * Both forms below were real, and both survived a clean `tsc` for the length
 * of the migration:
 *
 *   (payload as { correlationId: string }).correlationId   — 8 test harnesses
 *   frame.payload.correlationId                            — navigating in
 *
 * and the ledger's `correlationIdOf(payload)` was the same move behind a name.
 * Every one of them read as a routing lookup and returned `undefined` the
 * moment the key moved, with the compiler silent and the symptom a 30-second
 * timeout somewhere else entirely.
 *
 * NOT banned, because these are the shape the arc is FOR:
 *   - `frame.correlationId`, `envelope.correlationId`, `meta.correlationId`
 *     — reading the envelope, which is where the key now lives;
 *   - `body.correlationId` on a `BusEmitRequest` — the wire envelope, a
 *     declared sibling of `payload`, not a field inside it;
 *   - `correlationId` as a parameter, variable, or object key.
 *
 * There are no exemptions, deliberately: an exemption list is how a census
 * rots, and this one has nowhere to start.
 *
 * What it still cannot see: a read reached through a value that is `any` (the
 * `require()`-inside-`vi.hoisted()` shape `bus-compiler-visibility.test.ts`
 * documents). Running the suites is what catches those.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.next', 'build']);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * Two shapes, both measured in this repo:
 *   1. navigating INTO a payload for the key — `.payload.correlationId`;
 *   2. reaching it through a CAST — `… as <anything>).correlationId`, which
 *      is how every untyped read in the migration was written.
 */
const PAYLOAD_READS: ReadonlyArray<readonly [string, RegExp]> = [
  ['navigates into a payload', /\.\s*payload\s*\??\.\s*correlationId/g],
  ['reaches the key through a cast', /\bas\s+[^;\n]*?\)\s*\??\.\s*correlationId/g],
];

describe('nothing reads correlationId out of a payload', () => {
  test('neither by navigation nor through a cast', () => {
    const offenders: string[] = [];
    for (const root of ['packages', 'apps']) {
      for (const file of sources(join(REPO, root))) {
        const source = stripComments(readFileSync(file, 'utf-8'));
        for (const [why, pattern] of PAYLOAD_READS) {
          for (const m of source.matchAll(pattern)) {
            const line = source.slice(0, m.index).split('\n').length;
            offenders.push(`${relative(REPO, file)}:${line} — ${why}: ${m[0].trim()}`);
          }
        }
      }
    }
    expect(
      offenders,
      'correlationId is a routing fact and rides the envelope; a payload that carries it ' +
        'reads correctly right up until the key moves, and then returns undefined in silence',
    ).toEqual([]);
  });
});
