/**
 * The default renderers forward what BrowseView hands them: the annotations
 * and the session.
 *
 * An ImageBrowseRenderer that destructures only content/mimeType and mounts a
 * bare ImageViewer leaves shape annotations invisible in browse mode. The
 * renderer mounts the read-only annotation canvas (drawingMode=null), WITH
 * the session extension on MediaRendererProps — so clicks/hover route in
 * browse mode too, for the PDF renderer as well.
 *
 * Prop-capturing canvas mocks pin the contract: mounted, given the
 * annotations, read-only, session threaded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { within } from '@testing-library/react';
import { renderInEnglish } from '../../../test-utils';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';
import { BrowseView } from '../BrowseView';
import { resourceId } from '@semiont/core';

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
  resourceUri: resourceId('res-1'),
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
    const { container } = renderInEnglish(
      <BrowseView {...baseProps} content="blob:image-url" mimeType="image/png"
        annotations={annotations} session={session} />,
    );

    expect(within(container).getByText('svg-canvas-mock')).toBeInTheDocument();
    expect(captured.svg).toHaveLength(1);
    const props = captured.svg[0]!;
    expect(props.imageUrl).toBe('blob:image-url');
    expect(props.existingAnnotations).toEqual([shapeAnnotation()]); // the annotations arrive
    expect(props.drawingMode).toBeNull();                           // read-only in browse
    expect(props.session).toBe(session);                            // interaction parity
  });

  it('pdf browse forwards its annotations and the session', async () => {
    const session = fakeSession();
    const annotations = { ...emptyAnnotations, highlights: [shapeAnnotation()] };
    const { container } = renderInEnglish(
      <BrowseView {...baseProps} content="blob:pdf-url" mimeType="application/pdf"
        annotations={annotations} session={session} />,
    );

    await within(container).findByText('pdf-canvas-mock'); // flush the lazy canvas
    expect(captured.pdf).toHaveLength(1);
    const props = captured.pdf[0]!;
    expect(props.existingAnnotations).toEqual([shapeAnnotation()]); // the annotations arrive
    expect(props.drawingMode).toBeNull();
    expect(props.session).toBe(session);                            // without it a click is a no-op
    // Browse asks for the scrolling column.
    expect(props.pageLayout).toBe('scroll');
  });

  // Annotate is the mode people actually work in, so it gets the
  // column too — leaving it on Previous/Next would make the feature
  // invisible to its primary audience.
  it('the annotate registry asks for the column as well, with the live tool', async () => {
    const session = fakeSession();
    const { AnnotateView } = await import('../AnnotateView');
    const { container } = renderInEnglish(
      <AnnotateView
        content="blob:pdf-url"
        mimeType="application/pdf"
        resourceUri={resourceId("res-1")}
        annotations={emptyAnnotations}
        uiState={{
          selectedMotivation: 'highlighting',
          selectedClick: 'detail',
          selectedShape: 'rectangle',
          hoveredAnnotationId: null,
          scrollToAnnotationId: null,
        }}
        annotateMode
        session={session}
      />,
    );

    await within(container).findByText('pdf-canvas-mock');
    const props = captured.pdf.at(-1)!;
    expect(props.pageLayout).toBe('scroll');
    expect(props.drawingMode).toBe('rectangle'); // the tool still reaches the pages
  });
});
