/**
 * PdfAnnotationCanvas Component Tests
 *
 * Tests for PDF annotation canvas component including:
 * - Rendering states (loading, error, success)
 * - Page navigation controls
 * - Annotation display
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PdfAnnotationCanvas } from '../PdfAnnotationCanvas';
import { resourceId, annotationId, parseFragmentSelector } from '@semiont/core';
import { pdfToCanvasCoordinates } from '../../../lib/pdf-coordinates';
import { loadPdfDocument } from '../../../lib/browser-pdfjs';

import type { Annotation } from '@semiont/core';

// The page's text layer, as pdf.js reports it. Geometry is PDF points,
// bottom-left origin: "Hello world" sits on one line at y=700, "elsewhere" a
// hundred points below it.
// vi.hoisted: vi.mock's factory is lifted above these declarations.
const { MOCK_TEXT_ITEMS } = vi.hoisted(() => ({
  MOCK_TEXT_ITEMS: [
    { str: 'Hello', transform: [1, 0, 0, 1, 72, 700], width: 30, height: 12, hasEOL: false },
    { str: 'world', transform: [1, 0, 0, 1, 106, 700], width: 32, height: 12, hasEOL: true },
    { str: 'elsewhere', transform: [1, 0, 0, 1, 72, 600], width: 54, height: 12, hasEOL: true },
  ],
}));

const mockPage = (textItems: unknown[]) => ({
  getViewport: vi.fn().mockReturnValue({
    width: 612,
    height: 792,
    scale: 1.0,
    rotation: 0
  }),
  render: vi.fn().mockReturnValue({
    promise: Promise.resolve()
  }),
  getTextContent: vi.fn().mockResolvedValue({ items: textItems })
});

// Mock browser-pdfjs module
vi.mock('../../../lib/browser-pdfjs', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 3,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({
        width: 612,
        height: 792,
        scale: 1.0,
        rotation: 0
      }),
      render: vi.fn().mockReturnValue({
        promise: Promise.resolve()
      }),
      getTextContent: vi.fn().mockResolvedValue({ items: MOCK_TEXT_ITEMS })
    })
  }),
  renderPdfPageToDataUrl: vi.fn().mockResolvedValue({
    dataUrl: 'data:image/png;base64,mock',
    width: 612,
    height: 792
  })
}));

describe('PdfAnnotationCanvas', () => {
  const mockResourceId = resourceId('123');
  const mockPdfUrl = 'https://example.com/resources/123.pdf';

  beforeEach(() => {
    vi.clearAllMocks();

    // jsdom doesn't fire image onLoad or support clientWidth/clientHeight.
    // Mock requestAnimationFrame to run callbacks synchronously and
    // provide dimensions on the image element so the SVG overlay renders.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  test('renders loading state initially', () => {
    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        drawingMode={null}
      />
    );

    expect(screen.getByText(/loading pdf/i)).toBeInTheDocument();
  });

  test('renders page navigation controls after loading', async () => {
    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        drawingMode={null}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /previous/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  test('previous button is disabled on first page', async () => {
    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        drawingMode={null}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    const prevButton = screen.getByRole('button', { name: /previous/i });
    expect(prevButton).toBeDisabled();
  });

  test('next button is disabled on last page', async () => {
    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        drawingMode={null}
      />
    );

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    const nextButton = screen.getByRole('button', { name: /next/i });

    // Navigate to last page
    await user.click(nextButton);
    await user.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText(/page 3 of 3/i)).toBeInTheDocument();
    });

    expect(nextButton).toBeDisabled();
  });

  test('renders existing annotations', async () => {
    const mockAnnotations: Annotation[] = [
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotationId('ann-1'),
        target: {
          source: mockResourceId,
          selector: {
            type: 'FragmentSelector',
            value: 'page=1&viewrect=100,200,150,100',
            conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
          }
        },
        motivation: 'highlighting',
        created: new Date().toISOString()
      }
    ];

    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        existingAnnotations={mockAnnotations}
        drawingMode={null}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    // jsdom doesn't fire image onLoad or provide clientWidth/clientHeight.
    // Wait for the image element to appear, then simulate load with dimensions.
    await waitFor(() => {
      const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
      expect(img).toBeInTheDocument();
    });

    const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
    fireEvent.load(img);

    await waitFor(() => {
      // Annotation should be rendered in SVG
      const svg = document.querySelector('.semiont-pdf-annotation-canvas__svg');
      expect(svg).toBeInTheDocument();

      const rects = svg?.querySelectorAll('rect');
      expect(rects?.length).toBeGreaterThan(0);
    });
  });

  test('passes the annotation rect as browse.click third argument (A1 anchor)', async () => {
    const click = vi.fn();
    const session = {
      client: { browse: { click }, beckon: { hover: vi.fn() } },
    } as unknown as import('@semiont/sdk').SemiontSession;

    const mockAnnotations: Annotation[] = [
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotationId('ann-1'),
        target: {
          source: mockResourceId,
          selector: {
            type: 'FragmentSelector',
            value: 'page=1&viewrect=100,200,150,100',
            conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
          }
        },
        motivation: 'highlighting',
        created: new Date().toISOString()
      }
    ];

    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        existingAnnotations={mockAnnotations}
        drawingMode={null}
        session={session}
      />
    );

    await waitFor(() => {
      const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
      expect(img).toBeInTheDocument();
    });

    const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
    fireEvent.load(img);

    await waitFor(() => {
      const rects = document.querySelector('.semiont-pdf-annotation-canvas__svg')?.querySelectorAll('rect');
      expect(rects?.length).toBeGreaterThan(0);
    });

    const annotationRect = document.querySelector('.semiont-pdf-annotation-canvas__svg')!.querySelector('rect')!;
    fireEvent.click(annotationRect);

    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0]?.[0]).toBe('ann-1');
    expect(click.mock.calls[0]?.[1]).toBe('highlighting');
    const anchorRect = click.mock.calls[0]?.[2];
    expect(anchorRect).toBeDefined();
    expect(typeof anchorRect.width).toBe('number');
  });

  test('drawing-path hit-test emits browse.click with the annotation viewport rect', async () => {
    // A1 anchor: in drawing mode, a sub-10px click on an existing annotation
    // goes through the mouse-up hit-test, which owns the PDF→display
    // coordinate transform. Expected rect computed with the same lib
    // functions the component uses (scale is 1: display 612×792 == page).
    const click = vi.fn();
    const session = {
      client: { browse: { click }, beckon: { hover: vi.fn() } },
    } as unknown as import('@semiont/sdk').SemiontSession;

    const fragmentValue = 'page=1&viewrect=100,200,150,100';
    const mockAnnotations: Annotation[] = [
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotationId('ann-hit-1'),
        target: {
          source: mockResourceId,
          selector: {
            type: 'FragmentSelector',
            value: fragmentValue,
            conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
          }
        },
        motivation: 'highlighting',
        created: new Date().toISOString()
      }
    ];

    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        existingAnnotations={mockAnnotations}
        drawingMode="rectangle"
        selectedMotivation="highlighting"
        session={session}
      />
    );

    await waitFor(() => {
      const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
      expect(img).toBeInTheDocument();
    });

    const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
    fireEvent.load(img);

    await waitFor(() => {
      const rects = document.querySelector('.semiont-pdf-annotation-canvas__svg')?.querySelectorAll('rect');
      expect(rects?.length).toBeGreaterThan(0);
    });

    const pdfCoord = parseFragmentSelector(fragmentValue)!;
    const displayRect = pdfToCanvasCoordinates(pdfCoord, 792, 1.0);

    // Sub-10px gesture at the annotation's display-rect center (image rect is
    // zeros in jsdom, so client coordinates are display coordinates).
    const canvasContainer = document.querySelector('.semiont-pdf-annotation-canvas__container')!;
    const clickX = displayRect.x + displayRect.width / 2;
    const clickY = displayRect.y + displayRect.height / 2;
    fireEvent.mouseDown(canvasContainer, { clientX: clickX, clientY: clickY });
    fireEvent.mouseUp(canvasContainer, { clientX: clickX, clientY: clickY });

    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.calls[0]?.[0]).toBe('ann-hit-1');
    expect(click.mock.calls[0]?.[1]).toBe('highlighting');
    expect(click.mock.calls[0]?.[2]).toMatchObject({
      left: displayRect.x,
      top: displayRect.y,
      width: displayRect.width,
      height: displayRect.height,
    });
  });

  /**
   * Drives the drag → mark.request path far enough to inspect the selector.
   * `drag` is in canvas pixels; at scale 1 with a 612×792 page these are also
   * display coordinates, since jsdom's getBoundingClientRect returns zeros.
   */
  async function drawRectangle(
    drag: { fromX: number; fromY: number; toX: number; toY: number },
  ) {
    const request = vi.fn();
    const session = {
      client: { mark: { request }, beckon: { hover: vi.fn() } },
    } as unknown as import('@semiont/sdk').SemiontSession;

    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        drawingMode="rectangle"
        selectedMotivation="highlighting"
        session={session}
      />
    );

    await waitFor(() => {
      const img = document.querySelector('.semiont-pdf-annotation-canvas__image');
      expect(img).toBeInTheDocument();
    });

    const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
    fireEvent.load(img);

    const container = document.querySelector('.semiont-pdf-annotation-canvas__container')!;
    fireEvent.mouseDown(container, { clientX: drag.fromX, clientY: drag.fromY });
    fireEvent.mouseMove(container, { clientX: drag.toX, clientY: drag.toY });
    fireEvent.mouseUp(container, { clientX: drag.toX, clientY: drag.toY });

    return request;
  }

  // The manual-annotation capture gap (.plans/PDF-MANUAL-ANNOTATION-TEXT.md):
  // a hand-drawn rectangle stored geometry and nothing else, so every panel
  // that quotes an annotation showed it blank.
  test('a drawn rectangle carries the text it was drawn around', async () => {
    // The "Hello world" line in canvas space: PDF y=700..712 flips to
    // canvas y=80..92 on a 792pt page. Drag a box a little larger than it.
    const line = pdfToCanvasCoordinates(
      { page: 1, x: 72, y: 700, width: 60, height: 12 }, 792, 1.0,
    );
    const request = await drawRectangle({
      fromX: line.x - 2,
      fromY: line.y - 2,
      toX: line.x + line.width + 8,
      toY: line.y + line.height + 4,
    });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const [source, selector, motivation] = request.mock.calls[0];
    expect(source).toBe(resourceId('res-1'));
    expect(motivation).toBe('highlighting');
    expect(selector).toEqual([
      {
        type: 'FragmentSelector',
        conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
        value: expect.stringContaining('page=1&viewrect='),
      },
      { type: 'TextQuoteSelector', exact: 'Hello world' },
    ]);
  });

  test('a rectangle over blank space carries geometry only', async () => {
    // Between the two lines of text — nothing under the box. An empty-string
    // quote would assert the box was drawn around nothing, so emit no quote.
    const request = await drawRectangle({ fromX: 40, fromY: 120, toX: 200, toY: 150 });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const selector = request.mock.calls[0][1];
    expect(selector).toHaveLength(1);
    expect(selector[0].type).toBe('FragmentSelector');
  });

  test('a scanned page with no text layer carries geometry only', async () => {
    // Class B: pdf.js returns no runs, so the browser cannot do the job and
    // the annotation stays geometry-only pending async enrichment (Phase 2).
    vi.mocked(loadPdfDocument).mockResolvedValueOnce({
      numPages: 3,
      getPage: vi.fn().mockResolvedValue(mockPage([])),
    } as unknown as Awaited<ReturnType<typeof loadPdfDocument>>);

    const line = pdfToCanvasCoordinates(
      { page: 1, x: 72, y: 700, width: 60, height: 12 }, 792, 1.0,
    );
    const request = await drawRectangle({
      fromX: line.x - 2,
      fromY: line.y - 2,
      toX: line.x + line.width + 8,
      toY: line.y + line.height + 4,
    });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const selector = request.mock.calls[0][1];
    expect(selector).toHaveLength(1);
    expect(selector[0].type).toBe('FragmentSelector');
  });

  test('accepts a drawing gesture without throwing when drawing mode is active', async () => {
    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        drawingMode="rectangle"
        selectedMotivation="highlighting"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    const container = document.querySelector('.semiont-pdf-annotation-canvas__container');
    expect(container).toBeInTheDocument();

    if (container) {
      // Simulate a drawing gesture with sufficient drag distance (>10px).
      // Note: in jsdom, getBoundingClientRect returns zeros, so clientX/Y are
      // used directly as the canvas coordinates. displayDimensions is null
      // (no real image layout), so handleMouseUp exits early without emitting.
      // We verify the container accepts the events without throwing.
      fireEvent.mouseDown(container, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(container, { clientX: 200, clientY: 200 });
      fireEvent.mouseUp(container, { clientX: 200, clientY: 200 });

      // The event is only emitted when displayDimensions is available (real layout).
      // In jsdom this is not available, so we verify the component did not error.
      expect(container).toBeInTheDocument();
    }
  });
});
