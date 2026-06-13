/**
 * SIMPLER-JSON-LD Phase 2 — content reads on the pure-pipe model.
 *
 * - `resourceContent` decodes with the *response's* charset (via
 *   `decodeWithCharset`), not a blind UTF-8 `TextDecoder`, and threads no
 *   `accept` option (the route is a pure byte pipe).
 * - `resourceGraph` dereferences the metadata graph through the content
 *   transport's `getResourceGraph` (the HTTP `/jsonld` face), uncached.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { IContentTransport, ITransport, ResourceId } from '@semiont/core';
import { BrowseNamespace } from '../namespaces/browse';

function inertTransport(): ITransport {
  return {
    baseUrl: 'http://test',
    emit: async () => {},
    stream: () => new Subject().asObservable(),
    subscribeToResource: () => () => {},
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  } as unknown as ITransport;
}

describe('browse content reads — pure pipe (SIMPLER-JSON-LD Phase 2)', () => {
  let bus: EventBus;
  afterEach(() => { bus?.destroy(); });

  function makeBrowse(content: IContentTransport): BrowseNamespace {
    bus = new EventBus();
    return new BrowseNamespace(inertTransport(), bus, content);
  }

  it('resourceContent decodes with the response charset (iso-8859-1), no Accept', async () => {
    // "café" in ISO-8859-1: 0x63 0x61 0x66 0xE9. A blind UTF-8 decode would
    // mangle the 0xE9 byte; charset-aware decoding yields the correct string.
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const getBinary = vi.fn().mockResolvedValue({
      data: bytes.buffer,
      contentType: 'text/plain; charset=iso-8859-1',
    });
    const content = {
      putBinary: vi.fn(),
      getBinary,
      getBinaryStream: vi.fn(),
      getResourceGraph: vi.fn(),
      dispose: vi.fn(),
    } as unknown as IContentTransport;

    const browse = makeBrowse(content);
    const rId: ResourceId = makeResourceId('r1');

    expect(await browse.resourceContent(rId)).toBe('café');
    // Pure pipe: no `accept` option threaded to the transport.
    expect(getBinary).toHaveBeenCalledWith(rId);
  });

  it('resourceGraph dereferences via the content transport, uncached', async () => {
    const graph = { resource: { id: 'r1' }, annotations: [], entityReferences: [] };
    const getResourceGraph = vi.fn().mockResolvedValue(graph);
    const content = {
      putBinary: vi.fn(),
      getBinary: vi.fn(),
      getBinaryStream: vi.fn(),
      getResourceGraph,
      dispose: vi.fn(),
    } as unknown as IContentTransport;

    const browse = makeBrowse(content);
    const rId: ResourceId = makeResourceId('r1');

    const first = await browse.resourceGraph(rId);
    const second = await browse.resourceGraph(rId);

    expect(first).toBe(graph);
    expect(second).toBe(graph);
    expect(getResourceGraph).toHaveBeenCalledWith(rId);
    // Uncached / HTTP-not-bus: each await hits the transport afresh.
    expect(getResourceGraph).toHaveBeenCalledTimes(2);
  });
});
