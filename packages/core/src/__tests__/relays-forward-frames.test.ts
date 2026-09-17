/**
 * Every bus-to-bus relay goes through `relayFrames`.
 *
 *     transport.stream(channel).subscribe((payload) => {
 *       localBus.emit(channel, payload);          // correlationId gone
 *     });
 *
 * This compiles forever: `stream()` is payload-only, and the envelope on
 * `emit` is optional. Ten such relays shipped — six in the gateway, four in
 * the Archivist/Librarian pumps — each found by running the system.
 *
 * Writing the hop correctly by hand is not enough, because the next one is
 * written by someone reading a different file. So both shapes are banned
 * outside `relay-frames.ts`: the payload-only form AND a hand-rolled
 * `frames()`-to-`emit()` relay.
 *
 * Only re-emission counts; consuming a payload is fine. The gateway's plane
 * bridge is untouched — its sink is `ingest`, not `emit`, and its source is a
 * queue-group subscription, so it is a different hop and not this one.
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

/** Any per-channel subscription that could feed a relay, capturing the channel.
 *  `stream`/`on` are payload-only; `frames` carries the envelope but is still a
 *  hand-rolled hop everywhere except `relay-frames.ts`. */
const CHANNEL_SUBSCRIBE = /\.\s*(?:stream|on|frames)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.\s*subscribe\s*\(/g;

/** The one home of the relay itself. */
const RELAY_HOME = 'packages/core/src/relay-frames.ts';

/** The callback text, by balancing parens from `subscribe(`. A line window
 *  instead flags the emit a test does NEXT to a subscribe — five false
 *  positives on the first run. */
function callbackBody(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1);
}

describe('a bus-to-bus relay forwards frames', () => {
  test('every relay goes through relayFrames', () => {
    const offenders: string[] = [];
    for (const root of ['packages', 'apps']) {
      for (const file of sources(join(REPO, root))) {
        const path = relative(REPO, file);
        if (path === RELAY_HOME) continue;
        const source = stripComments(readFileSync(file, 'utf-8'));
        for (const m of source.matchAll(CHANNEL_SUBSCRIBE)) {
          const openParen = m.index + m[0].length - 1;
          // Re-emitting the SAME channel is a relay. A different channel is a
          // responder answering a request, which owes nothing to this rule.
          const sameChannel = new RegExp(`\\.\\s*emit\\s*\\(\\s*${m[1]}\\s*,`);
          if (!sameChannel.test(callbackBody(source, openParen))) continue;
          const line = source.slice(0, m.index).split('\n').length;
          offenders.push(`${path}:${line} — ${m[0].trim()}`);
        }
      }
    }
    expect(
      offenders,
      'a hand-rolled relay drops the envelope the moment someone writes it from the payload-only ' +
        'surface, and four shipped that way. Call relayFrames(from, to, channels) instead — it is ' +
        'the only place this hop is written',
    ).toEqual([]);
  });
});
