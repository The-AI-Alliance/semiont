/**
 * The time the SDK keeps, held at the line it is written.
 *
 * Every wait the SDK makes is a timer global, and every jitter it draws comes
 * from `Math.random`: a test's fake timers move the one, and a test replaces
 * the other (protocol/specs/src/client/surface.json, `clock`).
 * protocol/specs/src/client/clock-cases.json holds what they mean. So the
 * product source of core, http-transport and sdk makes no wait and takes no
 * reading that fake timers have no entry for, and draws from no generator of
 * its own but a secret's or an id's, each listed here with why.
 * `Date.now` and `performance.now`, which fake timers fake, are allowed.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, stripComments, typeScriptFiles } from './repository-files';

const PRODUCT_SOURCE = ['packages/typescript/core/src', 'packages/typescript/http-transport/src', 'packages/typescript/sdk/src'];

const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.tsx?$/;

/** What fake timers have no entry for, and what each is. */
const OUTSIDE_THE_CLOCK: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAbortSignal\s*\.\s*timeout\b/g, 'a deadline the runtime keeps natively'],
  [/\bscheduler\s*\.\s*wait\b/g, 'a wait the runtime keeps natively'],
  [/\bAtomics\s*\.\s*wait(?:Async)?\b/g, 'a wait on shared memory'],
  [/\bprocess\s*\.\s*uptime\b/g, 'a monotonic reading'],
];

/** A draw from a generator that is not `Math.random`. */
const OWN_DRAW = /\b(?:getRandomValues|randomUUID|randomBytes|randomInt|randomFillSync|randomFill)\b/g;

/** The files that draw from the platform's cryptographic source, and what for. Neither is a jitter. */
const SECRETS_AND_IDS = new Map<string, string>([
  ['packages/typescript/core/src/id-generation.ts', "ids, a client assertion's jti among them"],
  ['packages/typescript/sdk/src/session/oauth.ts', "a PKCE verifier and a sign-in's state"],
]);

/** Each place in `source` that waits, reads or draws outside the clock and the random source a test controls. */
function escapes(path: string, source: string): string[] {
  const read = stripComments(source);
  const found: string[] = [];
  const at = (index: number) => read.slice(0, index).split('\n').length;
  for (const [pattern, what] of OUTSIDE_THE_CLOCK) {
    for (const match of read.matchAll(pattern)) found.push(`${path}:${at(match.index)} ${match[0]}: ${what}`);
  }
  if (!SECRETS_AND_IDS.has(path)) {
    for (const match of read.matchAll(OWN_DRAW)) found.push(`${path}:${at(match.index)} ${match[0]}: a generator of its own`);
  }
  return found;
}

const productFiles = () => typeScriptFiles(...PRODUCT_SOURCE).filter((path) => !TEST_FILE.test(path));

describe('the SDK waits and draws only on what a test controls', () => {
  test('the census reads what it is shown', () => {
    const sample = [
      'const signal = AbortSignal.timeout(30_000);',
      'await scheduler.wait(10);',
      'Atomics.wait(cells, 0, 0, 5);',
      'const up = process.uptime();',
      'crypto.getRandomValues(new Uint8Array(4));',
      "import { randomInt } from 'node:crypto';",
      '// AbortSignal.timeout in a comment says nothing',
      'setTimeout(() => {}, 5); Date.now(); performance.now(); Math.random();',
    ].join('\n');
    expect(escapes('sample.ts', sample)).toEqual([
      'sample.ts:1 AbortSignal.timeout: a deadline the runtime keeps natively',
      'sample.ts:2 scheduler.wait: a wait the runtime keeps natively',
      'sample.ts:3 Atomics.wait: a wait on shared memory',
      'sample.ts:4 process.uptime: a monotonic reading',
      'sample.ts:5 getRandomValues: a generator of its own',
      'sample.ts:6 randomInt: a generator of its own',
    ]);
    expect(escapes('packages/typescript/sdk/src/session/oauth.ts', 'crypto.getRandomValues(buffer);')).toEqual([]);
  });

  test('nothing in the product source waits, reads or draws outside them', () => {
    const found = productFiles().flatMap((path) => escapes(path, readFileSync(join(REPO, path), 'utf-8')));
    expect(found, 'a wait, a reading or a draw that fake timers and Math.random do not reach').toEqual([]);
  });

  test('each file listed as drawing a secret or an id draws one', () => {
    const files = new Set(productFiles());
    const stale = [...SECRETS_AND_IDS].filter(
      ([path]) => !files.has(path) || !stripComments(readFileSync(join(REPO, path), 'utf-8')).match(OWN_DRAW),
    );
    expect(stale.map(([path, what]) => `${path} (${what})`), 'a listing whose file no longer draws: remove it').toEqual([]);
  });
});
