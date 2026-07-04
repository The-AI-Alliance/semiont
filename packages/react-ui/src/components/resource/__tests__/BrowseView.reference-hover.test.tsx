/**
 * EMBEDDABLE-VIEWER-COMPLETION Phase 2b — `onReferenceHover`.
 *
 * Hovering a RESOLVED reference span fires `onReferenceHover({annotation,
 * referent, anchorRect})` once — after the viewer's dwell AND the referent's
 * cached descriptor resolves. A stub fires nothing (not even null); leaving
 * before the descriptor resolves cancels (no fire, and no stray null); leaving
 * after a fire sends `null`; the beckon:hover panel-highlight emit is untouched.
 *
 * Started RED (no `onReferenceHover` prop) and GREEN once Phase 2b lands.
 * Test mechanics mirror BrowseView.test.tsx: mock target with `closest()`,
 * fake timers for the dwell, a BehaviorSubject standing in for the cached
 * `browse.resource` observable so the test controls resolve timing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BehaviorSubject } from 'rxjs';
import type { Annotation, AnnotationId, ResourceDescriptor } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { BrowseView } from '../BrowseView';

vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));
// jsdom has no Range API — the overlay is not under test here.
vi.mock('../../../lib/annotation-overlay', () => ({
  buildSourceToRenderedMap: vi.fn(() => new Map()),
  buildTextNodeIndex: vi.fn(() => []),
  resolveAnnotationRanges: vi.fn(() => new Map()),
  applyHighlights: vi.fn(),
  clearHighlights: vi.fn(),
  toOverlayAnnotations: vi.fn(() => []),
}));

const REFERENT = { '@id': 'res-target', name: 'Target Doc' } as unknown as ResourceDescriptor;
const DWELL = 100;

const makeAnnotation = (id: string, body: Annotation['body']): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: id as AnnotationId,
  type: 'Annotation',
  motivation: 'linking',
  creator: { '@type': 'Person', name: 'u' },
  created: '2024-01-01T00:00:00Z',
  target: { source: 'res-1', selector: { type: 'TextPositionSelector', start: 0, end: 4 } },
  body,
});

const resolvedRef = makeAnnotation('ref-resolved', [{ type: 'SpecificResource', source: 'res-target', purpose: 'linking' }]);
const stubRef = makeAnnotation('ref-stub', []);

function setup(onReferenceHover?: (h: unknown) => void) {
  const referent$ = new BehaviorSubject<ResourceDescriptor | undefined>(undefined);
  const beckonHover = vi.fn();
  const browseResource = vi.fn(() => referent$);
  const session = {
    client: {
      browse: { click: vi.fn(), resource: browseResource },
      beckon: { hover: beckonHover },
    },
    subscribe: () => () => {},
  } as unknown as SemiontSession;

  const { container } = render(
    <BrowseView
      content="some text"
      mimeType="text/plain"
      resourceUri="res-1"
      annotations={{ highlights: [], references: [resolvedRef, stubRef], assessments: [], comments: [], tags: [] }}
      annotateMode={false}
      hoverDelayMs={DWELL}
      session={session}
      {...(onReferenceHover ? { onReferenceHover } : {})}
    />,
  );
  const content = container.querySelector('.semiont-browse-view__content')!;

  const hoverTarget = (id: string) => {
    const el = document.createElement('span');
    el.setAttribute('data-annotation-id', id);
    return { el, target: { closest: vi.fn(() => el) } as unknown as Element };
  };

  return { content, referent$, beckonHover, browseResource, hoverTarget };
}

describe('BrowseView — onReferenceHover (Phase 2b)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires once after dwell + descriptor resolve, with {annotation, referent, anchorRect}', () => {
    const onReferenceHover = vi.fn();
    const { content, referent$, hoverTarget } = setup(onReferenceHover);

    fireEvent.mouseOver(content, { target: hoverTarget('ref-resolved').target });
    vi.advanceTimersByTime(DWELL + 10);        // dwell fires → subscribe starts
    expect(onReferenceHover).not.toHaveBeenCalled(); // descriptor not resolved yet

    referent$.next(REFERENT);                  // descriptor lands
    expect(onReferenceHover).toHaveBeenCalledTimes(1);
    const hover = onReferenceHover.mock.calls[0]![0];
    expect(hover.annotation.id).toBe('ref-resolved');
    expect(hover.referent).toBe(REFERENT);
    expect(typeof hover.anchorRect.top).toBe('number'); // DOMRect from the hovered span

    referent$.next({ ...REFERENT });           // later cache emissions must NOT re-fire
    expect(onReferenceHover).toHaveBeenCalledTimes(1);
  });

  it('a stub reference fires nothing — not even null on leave', () => {
    const onReferenceHover = vi.fn();
    const { content, beckonHover, hoverTarget } = setup(onReferenceHover);

    const { target } = hoverTarget('ref-stub');
    fireEvent.mouseOver(content, { target });
    vi.advanceTimersByTime(DWELL + 10);
    fireEvent.mouseOut(content, { target });

    expect(onReferenceHover).not.toHaveBeenCalled();
    expect(beckonHover).toHaveBeenCalledWith('ref-stub'); // panel-highlight path unaffected
  });

  it('leaving before the descriptor resolves cancels: no fire, and a late resolve stays silent', () => {
    const onReferenceHover = vi.fn();
    const { content, referent$, hoverTarget } = setup(onReferenceHover);

    const { target } = hoverTarget('ref-resolved');
    fireEvent.mouseOver(content, { target });
    vi.advanceTimersByTime(DWELL + 10);        // dwell fired, load in flight
    fireEvent.mouseOut(content, { target });   // leave first

    referent$.next(REFERENT);                  // late resolve
    expect(onReferenceHover).not.toHaveBeenCalled(); // cancelled — and no stray null either
  });

  it('leaving after a fire sends null', () => {
    const onReferenceHover = vi.fn();
    const { content, referent$, hoverTarget } = setup(onReferenceHover);

    const { target } = hoverTarget('ref-resolved');
    fireEvent.mouseOver(content, { target });
    vi.advanceTimersByTime(DWELL + 10);
    referent$.next(REFERENT);
    expect(onReferenceHover).toHaveBeenCalledTimes(1);

    fireEvent.mouseOut(content, { target });
    expect(onReferenceHover).toHaveBeenCalledTimes(2);
    expect(onReferenceHover).toHaveBeenLastCalledWith(null);
  });

  it('without onReferenceHover, hover still emits beckon:hover and loads nothing', () => {
    const { content, beckonHover, browseResource, hoverTarget } = setup();

    fireEvent.mouseOver(content, { target: hoverTarget('ref-resolved').target });
    vi.advanceTimersByTime(DWELL + 10);

    expect(beckonHover).toHaveBeenCalledWith('ref-resolved');
    expect(browseResource).not.toHaveBeenCalled(); // no handler → no referent load
  });
});
