/**
 * Census gate: the exported gateway-handler channel lists equal the two
 * handler files' ACTUAL subscriptions and emissions.
 *
 * `GATEWAY_HANDLER_CHANNELS` / `GATEWAY_HANDLER_EMITS` are hand-maintained
 * mirrors of what `bind-update-body.ts` and `job-commands.ts` do — and the
 * gateway's signal bridge trusts them, so a handler subscribing a new wire
 * channel without listing it would silently starve under a remote plane.
 * The root-parity gate asserts the root OBSERVES the listed channels (one
 * direction); this is the other direction: the list keeps pace with the
 * files. Exactly the gap that let `job:checkpoint` and `job:cancel` go
 * unlisted until 2026-09-15.
 *
 * CODE, not prose: comments are stripped before matching.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { GATEWAY_HANDLER_CHANNELS, GATEWAY_HANDLER_EMITS } from '../index.js';

const HANDLERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_HANDLER_FILES = ['bind-update-body.ts', 'job-commands.ts'];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function channelsMatching(pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const file of GATEWAY_HANDLER_FILES) {
    const source = stripComments(readFileSync(join(HANDLERS_DIR, file), 'utf-8'));
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found].sort();
}

describe('gateway handler census (lists == the files)', () => {
  test('GATEWAY_HANDLER_CHANNELS is exactly what the two files subscribe', () => {
    const subscribed = channelsMatching(/eventBus\.get\('([^']+)'\)\.subscribe/g);
    expect([...GATEWAY_HANDLER_CHANNELS].sort()).toEqual(subscribed);
  });

  test('GATEWAY_HANDLER_EMITS is exactly what the two files emit', () => {
    const emitted = channelsMatching(/eventBus\.get\('([^']+)'\)\.next/g);
    expect([...GATEWAY_HANDLER_EMITS].sort()).toEqual(emitted);
  });
});
