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
import { CHANNEL_ATTRS } from '@semiont/core';
import { GATEWAY_HANDLER_CHANNELS, GATEWAY_HANDLER_EMITS } from '../index.js';

/** Every channel a gateway-resident handler consumes or emits. */
type RosterChannel =
  | (typeof GATEWAY_HANDLER_CHANNELS)[number]
  | (typeof GATEWAY_HANDLER_EMITS)[number];

/**
 * Those of them the signal bridge would silently drop. Computed from the
 * generated attributes, so a reclassification enrols itself.
 */
type StrandedRosterChannel = {
  [K in RosterChannel]: (typeof CHANNEL_ATTRS)[K]['direction'] extends 'in-process' ? K : never;
}[RosterChannel];

/**
 * The gate. Only `never` is assignable to `never`, so this compiles ONLY
 * while no rostered channel is in-process; a regression fails the TYPECHECK
 * with `Type '"mark:body-update-failed"' is not assignable to type 'never'`,
 * naming the channel that would starve.
 */
const _noRosterChannelIsStranded: never = undefined as never as StrandedRosterChannel;

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

  test('no channel in either roster is classified in-process — the bridge would drop it', () => {
    // The lists above prove the ROSTERS match the files. This proves the
    // rosters are CARRIABLE, which is a different failure and the one that
    // actually bit: `bridgeGatewayHandlers` filters `direction: 'in-process'`
    // out of both halves, so a gateway-resident handler can be correctly
    // listed, correctly subscribed, and still never hear a thing once the
    // emitter is a different process.
    //
    // `mark:body-update-failed` was exactly that for the life of the
    // Archivist extraction: the Stower emitted it identically to
    // `mark:commit-failed` eleven lines away, but that one is a registered
    // operation's failure (so it derives `inbound`) and this one fell through
    // to the in-process list. A failed body update gave the client
    // `bus.timeout` after 30 s instead of the reason
    // (.plans/bugs/bind-body-update-failed-never-crosses.md).
    //
    // **The gate is the TYPE above, not this case.** Written as a runtime
    // filter first, it drew `TS2367: types '"outbound" | "inbound"' and
    // '"in-process"' have no overlap` — the compiler announcing it had
    // already proved the property, because both rosters are `as const` and
    // the generated `CHANNEL_ATTRS` carries a literal direction per channel.
    // A comparison that cannot be true is worth less than an assertion that
    // cannot compile: this one fails the moment the registry regenerates,
    // rather than the next time someone runs this package's suite.
    expect(_noRosterChannelIsStranded).toBeUndefined();
  });
});
