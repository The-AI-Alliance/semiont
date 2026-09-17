/**
 * A relay between two buses must forward the FRAME, never the payload.
 *
 *     transport.stream(channel).subscribe((payload) => {
 *       localBus.emit(channel, payload);          // correlationId gone
 *     });
 *
 * This compiles forever: `stream()` is payload-only, and the envelope on
 * `emit` is optional. Ten such relays have shipped — six in the gateway, four
 * in the Archivist/Librarian pumps — each found by running the system. The
 * correct form is `frames()` plus `{ correlationId: frame.correlationId }`.
 *
 * Only re-emission counts; consuming a payload is fine.
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

/** `x.stream(channel).subscribe(` or `x.on(channel).subscribe(` — the
 *  payload-only surfaces. `frames()` is the frame-carrying one and is fine. */
const PAYLOAD_SUBSCRIBE = /\.\s*(?:stream|on)\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\.\s*subscribe\s*\(/g;

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
  test('no relay re-emits from a payload-only subscription', () => {
    const offenders: string[] = [];
    for (const root of ['packages', 'apps']) {
      for (const file of sources(join(REPO, root))) {
        const source = stripComments(readFileSync(file, 'utf-8'));
        for (const m of source.matchAll(PAYLOAD_SUBSCRIBE)) {
          const openParen = m.index + m[0].length - 1;
          if (!/\.\s*emit\s*\(/.test(callbackBody(source, openParen))) continue;
          const line = source.slice(0, m.index).split('\n').length;
          offenders.push(`${relative(REPO, file)}:${line} — ${m[0].trim()}`);
        }
      }
    }
    expect(
      offenders,
      'a relay subscribing stream()/on() receives the payload alone, so the envelope — and with ' +
        'it every correlationId — is dropped at the hop. Subscribe frames() and pass ' +
        '{ correlationId: frame.correlationId } to emit, as http-transport.ts’s bridge does',
    ).toEqual([]);
  });
});
