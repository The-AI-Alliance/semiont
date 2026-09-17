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
 *
 * The patterns scan for the bus VERBS (`on` to subscribe, `emit` to publish).
 * They scanned `get(ch).subscribe` and `get(ch).next` until BUS-CARRIES-FRAMES
 * replaced the Subject-handing `get()` with verbs. The census's reason is
 * unchanged — the exported list must equal what the files actually do — and a
 * census whose regex silently matches nothing is the failure mode it exists to
 * prevent, so the patterns move with the syntax.
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
    // `.pipe(` counts as subscribing: the job:status responder consumed its
    // request through a pipe and the subscribe-only regex would have missed
    // it, had it lived in these files at the time.
    //
    // BOTH read verbs count. A responder reads `frames` to echo the key it
    // was handed (BUS-CARRIES-FRAMES P3); an `on`-only regex reported those
    // channels as unsubscribed and the census then agreed with a roster that
    // had silently shed half the gateway's handlers.
    const subscribed = channelsMatching(/eventBus\.(?:on|frames)\('([^']+)'\)\.(?:subscribe|pipe)/g);
    expect([...GATEWAY_HANDLER_CHANNELS].sort()).toEqual(subscribed);
  });

  test('GATEWAY_HANDLER_EMITS is exactly what the two files emit', () => {
    const emitted = channelsMatching(/eventBus\.emit\('([^']+)'/g);
    expect([...GATEWAY_HANDLER_EMITS].sort()).toEqual(emitted);
  });

  test('the composition root subscribes NOTHING inline — roots compose, handlers subscribe', () => {
    // The population pin. The census above is exact over the handler files,
    // but the bridge trusts the lists as the WHOLE gateway-resident set — a
    // subscriber composed anywhere else is invisible to it and starves under
    // a remote plane. The job:status responder lived inline in
    // createJobQueue (service.ts) and did exactly that (2026-09-16, the
    // yield:create bug's subscriber-side twin). Any new gateway-resident
    // subscription goes IN a censused handler file, never in the root.
    const source = stripComments(readFileSync(join(HANDLERS_DIR, '..', 'service.ts'), 'utf-8'));
    const inline = [...source.matchAll(/eventBus\.on\('([^']+)'\)\.(?:subscribe|pipe)/g)].map((m) => m[1]);
    expect(inline, 'inline eventBus subscriptions in service.ts').toEqual([]);
  });
});
