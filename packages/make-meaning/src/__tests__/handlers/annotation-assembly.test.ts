/**
 * The write path refuses unannotatable targets.
 *
 * A GUI that decides what to offer does not decide what is accepted: without a
 * gate on the write path an SDK or API caller can annotate a ZIP. The gate
 * goes on `mark:create-request` — the bus command every GUI and SDK caller
 * travels — and NOT on `mark:create`, the fact-writing channel Stower
 * consumes.
 *
 * The last case below pins that separation: gating `mark:create` would need a
 * leniency flag for any path that writes recorded facts, which is the
 * compatibility switch that gating only the request channel avoids.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { firstValueFrom, race, timer, take } from 'rxjs';
import { EventBus, resourceId, type Logger } from '@semiont/core';
import { registerAnnotationAssemblyHandler } from '../../handlers/annotation-assembly';

type AssemblyReads = Parameters<typeof registerAnnotationAssemblyHandler>[1];

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const USER_DID = 'did:web:test:users:test';
const RID = 'res-under-test';

/** A KB whose one resource carries `mediaType` as its primary representation. */
function kbServing(mediaType: string | undefined): AssemblyReads {
  return {
    views: {
      get: vi.fn().mockResolvedValue({
        resource: {
          '@context': 'https://schema.org/',
          '@id': resourceId(RID),
          name: 'Resource under test',
          representations: mediaType ? [{ mediaType, storageUri: 'file://x', checksum: 'c' }] : [],
        },
      }),
    },
  } as AssemblyReads;
}

const request = {
  motivation: 'commenting',
  target: { source: RID, selector: { type: 'TextPositionSelector', start: 0, end: 4 } },
  body: [{ type: 'TextualBody', value: 'note' }],
};

/** Whichever of the two outcomes arrives first, or 'none' if neither does. */
async function outcomeOf(bus: EventBus): Promise<{ channel: string; message?: string }> {
  const created = bus.on('mark:create').pipe(take(1));
  const failed = bus.on('mark:create-failed').pipe(take(1));
  return firstValueFrom(
    race(
      created.pipe(),
      failed.pipe(),
      timer(150),
    ).pipe(take(1)),
  ).then((v) =>
    typeof v === 'number'
      ? { channel: 'none' }
      : 'annotation' in (v as object)
        ? { channel: 'mark:create' }
        : { channel: 'mark:create-failed', message: (v as { message?: string }).message },
  );
}

describe('mark:create-request refuses unannotatable targets', () => {
  let bus: EventBus;
  beforeEach(() => {
    vi.clearAllMocks();
    bus = new EventBus();
  });

  it('lets an annotatable target through unchanged', async () => {
    registerAnnotationAssemblyHandler(bus, kbServing('text/markdown'), silentLogger);
    const pending = outcomeOf(bus);
    bus.emit('mark:create-request', { resourceId: RID, request, _userId: USER_DID } as never, { correlationId: 'cid-1' });
    expect((await pending).channel).toBe('mark:create');
  });

  it('refuses a storage-tier target, naming the media type', async () => {
    // `text/css` is a registry row with `anchoring: 'none'` — known, and declined.
    registerAnnotationAssemblyHandler(bus, kbServing('text/css'), silentLogger);
    const pending = outcomeOf(bus);
    bus.emit('mark:create-request', { resourceId: RID, request, _userId: USER_DID } as never, { correlationId: 'cid-2' });

    const outcome = await pending;
    expect(outcome.channel).toBe('mark:create-failed');
    expect(outcome.message).toContain('text/css');
  });

  it('refuses a target the registry has never seen', async () => {
    // Import leniency means a KB can hold these, and `textSourceOf` is
    // lenient for `text/*` so they embed and turn up in search — a user who
    // found one will reasonably try to annotate it. The refusal has to read
    // sanely for a type the registry cannot make vocabulary claims about.
    registerAnnotationAssemblyHandler(bus, kbServing('text/x-obscure-notation'), silentLogger);
    const pending = outcomeOf(bus);
    bus.emit('mark:create-request', { resourceId: RID, request, _userId: USER_DID } as never, { correlationId: 'cid-3' });

    const outcome = await pending;
    expect(outcome.channel).toBe('mark:create-failed');
    expect(outcome.message).toContain('text/x-obscure-notation');
    expect(outcome.message).toMatch(/cannot be annotated/);
  });

  it('leaves the fact-writing channel ungated — the gate is on the REQUEST channel', async () => {
    // Pins where the gate sits. A direct `mark:create` for a storage-tier
    // target must produce no refusal. Fires if the gate is "tidied" down into
    // Stower's convergence point, which would re-judge any recorded fact
    // replayed through it — or need a leniency flag to exempt one. Events are
    // facts, commands are requests: facts are outside this gate.
    registerAnnotationAssemblyHandler(bus, kbServing('text/css'), silentLogger);
    const failures: unknown[] = [];
    bus.on('mark:create-failed').subscribe((e) => failures.push(e));

    bus.emit('mark:create', { annotation: { id: 'ann-import-1' }, _userId: USER_DID, resourceId: resourceId(RID) } as never);
    await new Promise((r) => setTimeout(r, 50));

    expect(failures).toEqual([]);
  });
});
