/**
 * The worker declares ONE manifest, and it covers every channel worker code
 * consumes.
 *
 * `WORKER_CHANNELS` is the awaited-reply derivation plus
 * `WORKER_CONSUMED_BROADCASTS`, the one home for the broadcasts a worker
 * consumes (`job:queued` in the claim adapter, `job:cancel-requested` in the
 * worker process), and the transport is constructed with the union. Widened
 * by `addChannels` calls at their use sites instead, a widening can be
 * deleted without any list getting shorter, and every worker goes idle.
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
    // that the manifest does not name is one its transport never carries.
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
