/**
 * BUG: image-browse-renderer-drops-annotations — the default renderers must
 * forward what BrowseView hands them.
 *
 * ImageBrowseRenderer destructured only content/mimeType and mounted a bare
 * ImageViewer: shape annotations invisible in browse mode (annotate mode
 * proves the data). Fix: the read-only annotation canvas (drawingMode=null),
 * WITH the session extension on MediaRendererProps — clicks/hover route in
 * browse mode too, and the PDF renderer's pre-existing session-less click gap
 * heals in the same motion (per the fork note in the bug doc).
 *
 * Prop-capturing canvas mocks pin the contract: mounted, given the
 * annotations, read-only, session threaded. Started RED (image: no canvas at
 * all; pdf: no session) → GREEN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';
import { BrowseView } from '../BrowseView';

const captured = vi.hoisted(() => ({
  svg: [] as Record<string, unknown>[],
  pdf: [] as Record<string, unknown>[],
}));

vi.mock('../../image-annotation/SvgDrawingCanvas', () => ({
  SvgDrawingCanvas: (props: Record<string, unknown>) => {
    captured.svg.push(props);
    return <div className="semiont-svg-drawing-canvas">svg-canvas-mock</div>;
  },
}));
vi.mock('../../pdf-annotation/PdfAnnotationCanvas.client', () => ({
  PdfAnnotationCanvas: (props: Record<string, unknown>) => {
    captured.pdf.push(props);
    return <div>pdf-canvas-mock</div>;
  },
}));
vi.mock('../../annotation/AnnotateToolbar', () => ({ AnnotateToolbar: () => null }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

/** A shape annotation (SvgSelector region) — the image-annotation shape. */
function shapeAnnotation(): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: 'shape-1' as AnnotationId,
    type: 'Annotation',
    motivation: 'highlighting',
    creator: { '@type': 'Person', name: 'user@example.com' },
    created: '2026-07-14T00:00:00Z',
    target: {
      source: 'res-1',
      selector: { type: 'SvgSelector', value: '<svg><rect x="1" y="1" width="5" height="5"/></svg>' },
    },
  } as unknown as Annotation;
}

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

const baseProps = {
  resourceUri: 'res-1',
  annotateMode: false,
};

describe('browse-renderers — annotation + session forwarding (dispatch contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.svg.length = 0;
    captured.pdf.length = 0;
  });

  it('image browse mounts the read-only annotation canvas with the annotations and session', () => {
    const session = fakeSession();
    const annotations = { ...emptyAnnotations, highlights: [shapeAnnotation()] };
    const { container } = render(
      <BrowseView {...baseProps} content="blob:image-url" mimeType="image/png"
        annotations={annotations} session={session} />,
    );

    expect(within(container).getByText('svg-canvas-mock')).toBeInTheDocument();
    expect(captured.svg).toHaveLength(1);
    const props = captured.svg[0]!;
    expect(props.imageUrl).toBe('blob:image-url');
    expect(props.existingAnnotations).toEqual([shapeAnnotation()]); // the dropped prop
    expect(props.drawingMode).toBeNull();                           // read-only in browse
    expect(props.session).toBe(session);                            // interaction parity
  });

  it('pdf browse keeps its annotations (pinned) and gains the session (the healed click gap)', async () => {
    const session = fakeSession();
    const annotations = { ...emptyAnnotations, highlights: [shapeAnnotation()] };
    const { container } = render(
      <BrowseView {...baseProps} content="blob:pdf-url" mimeType="application/pdf"
        annotations={annotations} session={session} />,
    );

    await within(container).findByText('pdf-canvas-mock'); // flush the lazy canvas
    expect(captured.pdf).toHaveLength(1);
    const props = captured.pdf[0]!;
    expect(props.existingAnnotations).toEqual([shapeAnnotation()]); // pinned — worked before
    expect(props.drawingMode).toBeNull();
    expect(props.session).toBe(session);                            // NEW — was a session-less no-op
  });
});
