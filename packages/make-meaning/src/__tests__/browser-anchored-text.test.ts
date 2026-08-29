/**
 * `browse:anchored-text-requested` — the read side of ANCHORED-TEXT-CACHE Lane 5.
 *
 * What is worth pinning here is not "the store is read" but the three answers
 * a caller can get, because each drives different behaviour in a viewer:
 *
 *   a map          → quote the text under a hand-drawn rectangle
 *   null, settled  → this document has no map and never will; stop asking
 *   null, timeout  → not yet; the annotation ships with geometry only
 *
 * The barrier is the same one `llm-context` uses for vectors: a caller can
 * arrive before the Smelter has finished the resource it just uploaded, and
 * answering "no map" for a document that is merely still being read would be
 * wrong. Only `SmeltProgressTimeout` degrades — any other failure is a broken
 * progress fold and must surface rather than quietly become "no map".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { EventBus, type AnchoredText, type ExtractionOutcome, type Logger } from '@semiont/core';
import type { MakeMeaningConfig } from '../service';
import { Browser } from '../browser';
import { SmeltProgressTimeout } from '../smelt-progress';
import { createMockEmbeddingProvider } from './helpers/smelter-harness';

const mockLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => mockLogger,
};

const RID = 'res:scan';
const MAP: AnchoredText = {
  text: 'alpha beta',
  items: [{ start: 0, end: 5, page: 1, x: 72, y: 700, width: 28, height: 12 }],
};

const viewWithChecksum = {
  get: async () => ({
    resource: { representations: [{ checksum: 'sha256:abc' }] },
    annotations: {},
  }),
};

function browserOver(kb: Record<string, unknown>) {
  const eventBus = new EventBus();
  const browser = new Browser(
    kb as never,
    eventBus,
    { root: '/tmp' } as never,
    { services: { vectors: { type: 'memory' }, embedding: { type: 'ollama', model: 'nomic-embed-text' } }, gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 } } as MakeMeaningConfig,
    { enrich: async (entries: never[]) => entries },
    createMockEmbeddingProvider(),
    mockLogger,
  );
  return { eventBus, browser };
}

async function ask(eventBus: EventBus, browser: Browser) {
  await browser.initialize();
  const reply = firstValueFrom(
    eventBus.get('browse:anchored-text-result').pipe(filter((e) => e.correlationId === 'c1'), take(1)),
  );
  eventBus.get('browse:anchored-text-requested').next({ correlationId: 'c1', resourceId: RID });
  return reply;
}

let stop: (() => Promise<void>) | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { await stop?.(); stop = undefined; });

describe('browse:anchored-text-requested', () => {
  it('returns the stored map without consulting the barrier', async () => {
    const whenSettled = vi.fn();
    const { eventBus, browser } = browserOver({
      anchoredText: { read: async () => MAP, write: async () => {} },
      views: viewWithChecksum,
      smeltProgress: { whenSettled },
    });
    stop = () => browser.stop();

    expect((await ask(eventBus, browser)).response).toEqual(MAP);
    // A hit must not pay for a settle check — the common case is the fast case.
    expect(whenSettled).not.toHaveBeenCalled();
  });

  it('waits for the Smelter, then re-reads', async () => {
    let stored: AnchoredText | null = null;
    const { eventBus, browser } = browserOver({
      anchoredText: { read: async () => stored, write: async () => {} },
      views: viewWithChecksum,
      smeltProgress: {
        whenSettled: async () => { stored = MAP; return 'indexed' as const; },
      },
    });
    stop = () => browser.stop();

    expect((await ask(eventBus, browser)).response).toEqual(MAP);
  });

  it("answers null when the Smelter settled 'skipped'", async () => {
    // A decision, not a delay: the document declined extraction, so no amount
    // of waiting produces a map. Re-reading the store would be pointless.
    const read = vi.fn(async () => null);
    const { eventBus, browser } = browserOver({
      anchoredText: { read, write: async () => {} },
      views: viewWithChecksum,
      smeltProgress: { whenSettled: async () => 'skipped' as const },
    });
    stop = () => browser.stop();

    expect((await ask(eventBus, browser)).response).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('answers null when the barrier times out', async () => {
    const { eventBus, browser } = browserOver({
      anchoredText: { read: async () => null, write: async () => {} },
      views: viewWithChecksum,
      smeltProgress: {
        whenSettled: async () => { throw new SmeltProgressTimeout(RID, 'sha256:abc', 10); },
      },
    });
    stop = () => browser.stop();

    expect((await ask(eventBus, browser)).response).toBeNull();
  });

  it('fails the request when the progress fold is broken', async () => {
    // Not a timeout. A fold that throws anything else is a defect, and turning
    // it into "no map" would hide it behind an outcome that looks routine.
    const { eventBus, browser } = browserOver({
      anchoredText: { read: async () => null, write: async () => {} },
      views: viewWithChecksum,
      smeltProgress: { whenSettled: async () => { throw new Error('fold is broken'); } },
    });
    stop = () => browser.stop();
    await browser.initialize();

    const failure = firstValueFrom(
      eventBus.get('browse:anchored-text-failed').pipe(filter((e) => e.correlationId === 'c1'), take(1)),
    );
    eventBus.get('browse:anchored-text-requested').next({ correlationId: 'c1', resourceId: RID });

    expect((await failure).message).toContain('fold is broken');
  });
});

/**
 * The checksum-addressed consult (ANCHORED-TEXT-TO-SMELTER P2, D2).
 *
 * The detection workers' read-through cache: the caller already computed the
 * checksum from bytes it holds, so there is no resourceId to resolve and no
 * content generation to wait for — no view read, no settle barrier. A hit —
 * success OR decline — is served whole and the worker skips extraction; null
 * is a miss and the worker extracts locally and discards.
 */
describe('browse:anchored-text-by-checksum-requested', () => {
  const OUTCOME: ExtractionOutcome = { kind: 'extracted', method: 'ocr', ...MAP };

  async function consult(eventBus: EventBus, browser: Browser, checksum: string) {
    await browser.initialize();
    const reply = firstValueFrom(
      eventBus.get('browse:anchored-text-by-checksum-result').pipe(filter((e) => e.correlationId === 'c1'), take(1)),
    );
    eventBus.get('browse:anchored-text-by-checksum-requested').next({ correlationId: 'c1', checksum });
    return reply;
  }

  it('serves a stored outcome whole, straight from the store', async () => {
    const read = vi.fn(async () => OUTCOME);
    const whenSettled = vi.fn();
    const viewsGet = vi.fn();
    const { eventBus, browser } = browserOver({
      anchoredText: { read },
      views: { get: viewsGet },
      smeltProgress: { whenSettled },
    });
    stop = () => browser.stop();

    expect((await consult(eventBus, browser, 'sha256:abc')).response).toEqual(OUTCOME);
    expect(read).toHaveBeenCalledWith('sha256:abc');
    // The caller holds the content identity: nothing to resolve, nothing to
    // wait for. Paying for either would reintroduce what this address avoids.
    expect(viewsGet).not.toHaveBeenCalled();
    expect(whenSettled).not.toHaveBeenCalled();
  });

  it('a decline is a hit — served whole so the caller can skip extraction', async () => {
    const declined: ExtractionOutcome = { kind: 'declined', declined: 'encrypted' };
    const { eventBus, browser } = browserOver({
      anchoredText: { read: async () => declined },
      views: viewWithChecksum,
      smeltProgress: { whenSettled: vi.fn() },
    });
    stop = () => browser.stop();

    expect((await consult(eventBus, browser, 'sha256:abc')).response).toEqual(declined);
  });

  it('answers null on a miss without waiting', async () => {
    const whenSettled = vi.fn();
    const { eventBus, browser } = browserOver({
      anchoredText: { read: async () => null },
      views: viewWithChecksum,
      smeltProgress: { whenSettled },
    });
    stop = () => browser.stop();

    expect((await consult(eventBus, browser, 'sha256:abc')).response).toBeNull();
    // A miss means "extract it yourself", not "wait and re-ask": with no
    // resourceId there is no generation the barrier could even key on.
    expect(whenSettled).not.toHaveBeenCalled();
  });

  it('fails the request when the store read throws', async () => {
    // The real store never throws — every failure path is a miss — but the
    // handler must not wedge the channel if that contract is ever broken.
    const { eventBus, browser } = browserOver({
      anchoredText: { read: async () => { throw new Error('store on fire'); } },
      views: viewWithChecksum,
      smeltProgress: { whenSettled: vi.fn() },
    });
    stop = () => browser.stop();
    await browser.initialize();

    const failure = firstValueFrom(
      eventBus.get('browse:anchored-text-by-checksum-failed').pipe(filter((e) => e.correlationId === 'c1'), take(1)),
    );
    eventBus.get('browse:anchored-text-by-checksum-requested').next({ correlationId: 'c1', checksum: 'sha256:abc' });

    expect((await failure).message).toContain('store on fire');
  });
});
