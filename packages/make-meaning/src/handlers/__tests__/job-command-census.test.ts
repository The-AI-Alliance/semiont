/**
 * Census gate: `JOB_COMMAND_CHANNELS` equals what `job-commands.ts` ACTUALLY
 * subscribes.
 *
 * `JOB_COMMAND_CHANNELS` is a hand-maintained mirror of the channels
 * `registerJobCommandHandlers` subscribes, and two consumers trust it as the
 * complete set: the in-process root (`HANDLER_CHANNELS`, via `startMakeMeaning`)
 * and the DISPATCHER's inbound roster (`service-channels.ts`, the deployed
 * fleet's owner of these handlers — EXTRACT-JOBS P2). A handler subscribing a
 * new `job:*` channel without listing it would silently starve on the
 * dispatcher. The root-parity gate asserts the root OBSERVES the listed
 * channels (one direction); this is the other direction: the list keeps pace
 * with the file. Exactly the gap that let `job:checkpoint` and `job:cancel` go
 * unlisted until 2026-09-15.
 *
 * The EMITS half retired with the gateway's signal bridge (EXTRACT-JOBS P3):
 * the dispatcher's OUTBOUND pump DERIVES its replies from `BUS_OPERATIONS` over
 * this inbound set (`replyChannelsFor`), so there is no hand-written emit list
 * left to census. Likewise the "no rostered channel is in-process" gate, which
 * guarded the bridge's direction filter — with the bridge gone and the
 * dispatcher subscribing fan-out through `/bus/subscribe` (which delivers every
 * frame regardless of classification), nothing filters by direction anymore.
 *
 * CODE, not prose: comments are stripped before matching.
 *
 * The patterns scan for the bus VERBS (`on`/`frames` to subscribe). They
 * scanned `get(ch).subscribe` until BUS-CARRIES-FRAMES replaced the
 * Subject-handing `get()` with verbs. The census's reason is unchanged — the
 * exported list must equal what the file actually does — and a census whose
 * regex silently matches nothing is the failure mode it exists to prevent, so
 * the patterns move with the syntax.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JOB_COMMAND_CHANNELS } from '../index.js';

const HANDLERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const JOB_COMMAND_FILES = ['job-commands.ts'];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function channelsMatching(pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const file of JOB_COMMAND_FILES) {
    const source = stripComments(readFileSync(join(HANDLERS_DIR, file), 'utf-8'));
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found].sort();
}

describe('job command census (list == the file)', () => {
  test('JOB_COMMAND_CHANNELS is exactly what job-commands.ts subscribes', () => {
    // BOTH read verbs count. A responder reads `frames` to echo the key it was
    // handed (BUS-CARRIES-FRAMES P3); the fire-and-forget handlers read `on`.
    // An `on`-only regex reported the `frames` responders as unsubscribed and
    // the census then agreed with a roster that had silently shed half the
    // handlers.
    const subscribed = channelsMatching(/eventBus\.(?:on|frames)\('([^']+)'\)\.(?:subscribe|pipe)/g);
    expect([...JOB_COMMAND_CHANNELS].sort()).toEqual(subscribed);
  });

  test('the composition root subscribes NOTHING inline — roots compose, handlers subscribe', () => {
    // The population pin. The census above is exact over `job-commands.ts`, but
    // the roster trusts the list as the WHOLE job-command subscription set — a
    // subscriber composed anywhere else is invisible to it and starves on the
    // dispatcher. The job:status responder lived inline in `createJobQueue`
    // (service.ts) and did exactly that (2026-09-16, the yield:create bug's
    // subscriber-side twin). Any new job-command subscription goes IN
    // `job-commands.ts`, never in the root.
    const source = stripComments(readFileSync(join(HANDLERS_DIR, '..', 'service.ts'), 'utf-8'));
    const inline = [...source.matchAll(/eventBus\.on\('([^']+)'\)\.(?:subscribe|pipe)/g)].map((m) => m[1]);
    expect(inline, 'inline eventBus subscriptions in service.ts').toEqual([]);
  });
});
