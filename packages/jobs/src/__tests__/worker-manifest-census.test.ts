/**
 * RED (CLIENT-SUBSCRIPTION-MANIFEST P2, D2/D3): the worker declares ONE
 * manifest, and it covers every channel worker code consumes.
 *
 * `WORKER_CHANNELS` was the AWAITED-reply derivation only; the broadcasts a
 * worker consumes lived as `addChannels` calls scattered at their use sites —
 * `job:queued` in the claim adapter, `job:cancel-requested` in the worker
 * process. Nothing compared the two, so on 2026-09-16 the `job:queued`
 * widening was deleted as redundant, every worker went idle, and no list got
 * shorter. `WORKER_CONSUMED_BROADCASTS` gives those one home, and the
 * transport is constructed with the union.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { replyChannelsFor } from '@semiont/core';
import {
  WORKER_CHANNELS,
  WORKER_CONSUMED_BROADCASTS,
  WORKER_AWAITED_OPERATIONS,
} from '../worker-runtime';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_FILES = ['job-claim-adapter.ts', 'worker-process.ts', 'worker-runtime.ts'];
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const sources = () =>
  WORKER_FILES.map((f) => ({ file: f, text: stripComments(readFileSync(join(SRC, f), 'utf-8')) }));

describe('worker subscription manifest', () => {
  it('WORKER_CHANNELS is the awaited replies UNION the consumed broadcasts', () => {
    const expected = new Set<string>([
      ...replyChannelsFor(WORKER_AWAITED_OPERATIONS),
      ...WORKER_CONSUMED_BROADCASTS,
    ]);
    expect(new Set<string>(WORKER_CHANNELS)).toEqual(expected);
  });

  it('every broadcast the worker streams is declared in the manifest', () => {
    // The `stream('x')` / `on('x')` census: a channel consumed by worker code
    // that the manifest does not name is the 2026-09-16 outage exactly.
    const manifest = new Set<string>(WORKER_CHANNELS);
    const consumed = new Set<string>();
    for (const { text } of sources()) {
      for (const m of text.matchAll(/\.(?:stream|on)\('([^']+)'/g)) consumed.add(m[1]!);
    }
    const undeclared = [...consumed].filter((c) => !manifest.has(c));
    expect(undeclared, 'worker consumes channels its manifest does not declare').toEqual([]);
  });

  it('no worker file widens its subscription set after construction', () => {
    const widening = sources().filter(({ text }) => /addChannels/.test(text)).map(({ file }) => file);
    expect(widening, 'the manifest is the whole set — nothing left to widen').toEqual([]);
  });

  it('every consumed broadcast has a consumer — no dead entries', () => {
    const consumed = new Set<string>();
    for (const { text } of sources()) {
      for (const m of text.matchAll(/\.(?:stream|on)\('([^']+)'/g)) consumed.add(m[1]!);
    }
    const dead = [...WORKER_CONSUMED_BROADCASTS].filter((c) => !consumed.has(c));
    expect(dead, 'declared broadcasts nothing consumes').toEqual([]);
  });
});
