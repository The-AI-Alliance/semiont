/**
 * A1 anchor thread — the `browse.click` payload contract.
 *
 * The anchorRect is a runtime-only enrichment: present exactly when the
 * emitter passed geometry, and never present as an `undefined`-valued key
 * (equality matchers ignore those, so this pins the key itself).
 */
import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { EventBus, annotationId } from '@semiont/core';
import type { AnchorRect, IContentTransport, ITransport } from '@semiont/core';
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

describe('browse.click anchorRect payload contract', () => {
  it('omits the anchorRect key entirely when no geometry is passed', () => {
    const bus = new EventBus();
    const browse = new BrowseNamespace(inertTransport(), bus, {} as unknown as IContentTransport);

    const payloads: object[] = [];
    bus.get('browse:click').subscribe((p) => payloads.push(p));

    browse.click(annotationId('a1'), 'linking');

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({ annotationId: 'a1', motivation: 'linking' });
    expect('anchorRect' in payloads[0]!).toBe(false);
  });

  it('carries the anchorRect verbatim when geometry is passed', () => {
    const bus = new EventBus();
    const browse = new BrowseNamespace(inertTransport(), bus, {} as unknown as IContentTransport);

    const payloads: object[] = [];
    bus.get('browse:click').subscribe((p) => payloads.push(p));

    const anchorRect: AnchorRect = {
      x: 1, y: 2, width: 3, height: 4, top: 2, right: 4, bottom: 6, left: 1,
    };
    browse.click(annotationId('a1'), 'highlighting', anchorRect);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      annotationId: 'a1',
      motivation: 'highlighting',
      anchorRect,
    });
  });
});
