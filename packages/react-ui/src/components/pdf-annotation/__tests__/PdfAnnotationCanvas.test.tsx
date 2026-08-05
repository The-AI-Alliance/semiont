/**
 * PdfAnnotationCanvas Component Tests
 *
 * Tests for PDF annotation canvas component including:
 * - Rendering states (loading, error, success)
 * - Page navigation controls
 * - Annotation display
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PdfAnnotationCanvas } from '../PdfAnnotationCanvas';
import { TranslationProvider } from '../../../contexts/TranslationContext';
import { defaultMocks } from '../../../test-utils';
import { resourceId, annotationId, parseFragmentSelector } from '@semiont/core';
import { pdfToCanvasCoordinates } from '../../../lib/pdf-coordinates';
import { loadPdfDocument, renderPdfPageToDataUrl } from '../../../lib/browser-pdfjs';

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


/**
 * jsdom has no IntersectionObserver. This stub records what the component
 * observes and hands the test the callback, so a "scroll" is an explicit
 * fire() rather than a simulated layout — jsdom has no layout either.
 */
function stubIntersectionObserver() {
  // (element, callback) PAIRS, not a map keyed by element: the component runs
  // two observers over the same slots — one widened for preloading, one bare
  // for "what is on screen" — and a map would keep only the last registered.
  const observed: Array<{ el: Element; cb: IntersectionObserverCallback }> = [];
  const margins = new Map<IntersectionObserverCallback, string>();
  class FakeIO {
    constructor(private cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      margins.set(cb, options?.rootMargin ?? '0px');
    }
    observe(el: Element) { observed.push({ el, cb: this.cb }); }
    unobserve(el: Element) {
      for (let i = observed.length - 1; i >= 0; i--) {
        if (observed[i]!.el === el && observed[i]!.cb === this.cb) observed.splice(i, 1);
      }
    }
    disconnect() {
      for (let i = observed.length - 1; i >= 0; i--) {
        if (observed[i]!.cb === this.cb) observed.splice(i, 1);
      }
    }
    takeRecords() { return []; }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);

  /** Fire only the observer that has no preload margin — the one that decides
   *  which page the reader is actually looking at. */
  function fireFor(visible: number[], match: (rootMargin: string) => boolean) {
    const byCb = new Map<IntersectionObserverCallback, IntersectionObserverEntry[]>();
    for (const { el, cb } of observed) {
      if (!match(margins.get(cb) ?? '0px')) continue;
      const page = Number((el as HTMLElement).dataset.page);
      byCb.set(cb, [...(byCb.get(cb) ?? []), {
        target: el, isIntersecting: visible.includes(page),
      } as unknown as IntersectionObserverEntry]);
    }
    act(() => { for (const [cb, entries] of byCb) cb(entries, {} as IntersectionObserver); });
  }

  /** Only the bare observer — what the reader can actually see. */
  function fireOnscreen(visible: number[]) {
    fireFor(visible, (m) => m === '0px');
  }

  return {
    fireOnscreen,
    /**
     * Fire both observers: these pages are mounted AND on screen — the
     * ordinary case. A test that needs the two to differ (a page preloaded
     * but not yet visible) calls `fireOnscreen` afterwards to narrow it.
     */
    fire(visible: number[]) {
      fireFor(visible, () => true);
    },
  };
}

describe('PdfAnnotationCanvas', () => {
  const mockResourceId = resourceId('123');
  const mockPdfUrl = 'https://example.com/resources/123.pdf';

  afterEach(() => {
    // Stubs must not leak into other files sharing this Vitest environment.
    vi.unstubAllGlobals();
  });

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

  // Phase 2 of .plans/PDF-MANUAL-ANNOTATION-TEXT.md. A scanned page has no text
  // in the browser, but the server derived one at ingest and serves it through
  // `browse.resourceAnchoredText`. Same `AnchoredText` shape either way, so
  // `textUnder` and the drag handler do not branch — only the source does.
  test('a scanned page quotes from the map the server derived', async () => {
    vi.mocked(loadPdfDocument).mockResolvedValueOnce({
      numPages: 3,
      getPage: vi.fn().mockResolvedValue(mockPage([])),
    } as unknown as Awaited<ReturnType<typeof loadPdfDocument>>);

    const request = vi.fn();
    const session = {
      client: {
        mark: { request },
        beckon: { hover: vi.fn() },
        browse: {
          resourceAnchoredText: vi.fn().mockResolvedValue({
            text: 'Hello world again',
            items: [
              { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },
              { start: 6, end: 11, page: 1, x: 106, y: 700, width: 32, height: 12 },
            ],
          }),
        },
      },
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
      expect(document.querySelector('.semiont-pdf-annotation-canvas__image')).toBeInTheDocument();
    });
    const img = document.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
    fireEvent.load(img);

    const line = pdfToCanvasCoordinates({ page: 1, x: 72, y: 700, width: 66, height: 12 }, 792, 1.0);
    const container = document.querySelector('.semiont-pdf-annotation-canvas__container')!;
    fireEvent.mouseDown(container, { clientX: line.x - 2, clientY: line.y - 2 });
    fireEvent.mouseMove(container, { clientX: line.x + line.width + 8, clientY: line.y + line.height + 4 });
    fireEvent.mouseUp(container, { clientX: line.x + line.width + 8, clientY: line.y + line.height + 4 });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][1]).toEqual([
      expect.objectContaining({ type: 'FragmentSelector' }),
      { type: 'TextQuoteSelector', exact: 'Hello world' },
    ]);
  });

  // PERSIST-ANCHORS P4. The server map is WHOLE-RESOURCE — one artifact
  // covering every page — so fetching it from inside the per-page load
  // effect refetched and re-decoded the entire document's geometry on every
  // page turn. On a 400-page scan that is the difference between one decode
  // and one per interaction.
  test('the whole-resource map is fetched once per document, not once per page-turn', async () => {
    vi.mocked(loadPdfDocument).mockResolvedValueOnce({
      numPages: 3,
      getPage: vi.fn().mockResolvedValue(mockPage([])),
    } as unknown as Awaited<ReturnType<typeof loadPdfDocument>>);

    const resourceAnchoredText = vi.fn().mockResolvedValue({
      text: 'Hello world again',
      items: [
        { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },
        { start: 6, end: 11, page: 2, x: 106, y: 700, width: 32, height: 12 },
      ],
    });
    const session = {
      client: { beckon: { hover: vi.fn() }, browse: { resourceAnchoredText } },
    } as unknown as import('@semiont/sdk').SemiontSession;

    render(
      <PdfAnnotationCanvas resourceUri="res-1"
        pdfUrl={mockPdfUrl}
        drawingMode={null}
        session={session}
      />
    );

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => {
      expect(screen.getByText(/page 2 of 3/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => {
      expect(screen.getByText(/page 3 of 3/i)).toBeInTheDocument();
    });

    // The render half runs once per page load and starts alongside the
    // anchoring half (Promise.all), so three render calls prove all three
    // page-load effects ran to the point of resolving their map.
    await waitFor(() => {
      expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalledTimes(3);
    });

    expect(resourceAnchoredText).toHaveBeenCalledTimes(1);
  });

  test('a scanned page with no server map carries geometry only', async () => {
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

  // PDF-CONTINUOUS-SCROLL S1. Browse mode scrolls: every page has a slot so
  // the scrollbar is honest about the document's length, but only a window of
  // pages is MOUNTED — unmounting is what releases a page's raster, so the
  // window IS the memory budget (D2).
  describe('scroll layout (browse mode)', () => {
    const scannedDoc = () =>
      vi.mocked(loadPdfDocument).mockResolvedValueOnce({
        numPages: 5,
        getPage: vi.fn().mockResolvedValue(mockPage([])),
      } as unknown as Awaited<ReturnType<typeof loadPdfDocument>>);

    const mountedPages = () =>
      [...document.querySelectorAll('.semiont-pdf-annotation-canvas__image')]
        .map((img) => Number((img as HTMLImageElement).alt.replace(/\D+/g, '')))
        .sort((a, b) => a - b);

    test('gives every page a slot but mounts only the visible window', async () => {
      const io = stubIntersectionObserver();
      scannedDoc();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );

      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });
      // Nothing rasterized before anything is visible.
      expect(mountedPages()).toEqual([]);

      io.fire([1, 2]);
      await waitFor(() => expect(mountedPages()).toEqual([1, 2]));
      expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
    });

    test('releases a page that scrolls out of the window', async () => {
      const io = stubIntersectionObserver();
      scannedDoc();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });

      io.fire([1, 2]);
      await waitFor(() => expect(mountedPages()).toEqual([1, 2]));

      io.fire([4, 5]);
      await waitFor(() => expect(mountedPages()).toEqual([4, 5]));
    });

    test('still fetches the whole-resource map once, across many mounted pages (P4)', async () => {
      // P4's invariant has to survive the move from one shared page-load
      // effect into N independent page views.
      const io = stubIntersectionObserver();
      scannedDoc();

      const resourceAnchoredText = vi.fn().mockResolvedValue({
        text: 'Hello world again',
        items: [{ start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 }],
      });
      const session = {
        client: { beckon: { hover: vi.fn() }, browse: { resourceAnchoredText } },
      } as unknown as import('@semiont/sdk').SemiontSession;

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
          session={session}
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });

      io.fire([1, 2, 3]);
      await waitFor(() => expect(mountedPages()).toEqual([1, 2, 3]));
      io.fire([3, 4, 5]);
      await waitFor(() => expect(mountedPages()).toEqual([3, 4, 5]));

      expect(resourceAnchoredText).toHaveBeenCalledTimes(1);
    });

    test('a slot keeps its reserved height when its page mounts', async () => {
      // S1b. Releasing the reservation on mount is what made the column's
      // total height change on every scroll — the scrollbar jumped and
      // resized under the cursor. The reservation must survive mounting so
      // the column's geometry never depends on which pages are mounted.
      const io = stubIntersectionObserver();
      scannedDoc();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });

      const slotOf = (page: number) =>
        document.querySelector(`.semiont-pdf-annotation-canvas__slot[data-page="${page}"]`) as HTMLElement;

      // Read whichever property expresses the reservation, so the pin is
      // about the CONTRACT (space is reserved, and mounting does not release
      // it) rather than about which CSS property implements it.
      const reserved = (el: HTMLElement) => el.style.minHeight || el.style.height;

      io.fire([1]);
      await waitFor(() => expect(mountedPages()).toEqual([1]));

      // Page 5 is unmounted and must hold space open.
      expect(reserved(slotOf(5))).not.toBe('');
      // Page 1 is mounted and must hold exactly the same space, or the
      // column's height changes as pages come and go.
      expect(reserved(slotOf(1))).toBe(reserved(slotOf(5)));
    });

    test('a rectangle drawn on a scrolled page carries THAT page number', async () => {
      // S2. The drag lives in the page view, so page identity comes from the
      // component that owns the pixels rather than from a shared `pageNumber`
      // — the invariant that makes a column safe to draw on at all.
      const io = stubIntersectionObserver();
      scannedDoc();

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
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });

      io.fire([2, 3]);
      await waitFor(() => expect(mountedPages()).toEqual([2, 3]));

      // Draw on page 3's container, not page 2's.
      const slot3 = document.querySelector('.semiont-pdf-annotation-canvas__slot[data-page="3"]')!;
      const img = slot3.querySelector('.semiont-pdf-annotation-canvas__image') as HTMLImageElement;
      Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
      Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
      fireEvent.load(img);

      const container = slot3.querySelector('.semiont-pdf-annotation-canvas__container')!;
      fireEvent.mouseDown(container, { clientX: 40, clientY: 40 });
      fireEvent.mouseMove(container, { clientX: 200, clientY: 160 });
      fireEvent.mouseUp(container, { clientX: 200, clientY: 160 });

      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request.mock.calls[0][1][0].value).toContain('page=3');
    });

    test('annotate mode scrolls too — the primary mode is not left on the pager', async () => {
      // The registries are the seam: both now ask for the column.
      const io = stubIntersectionObserver();
      scannedDoc();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode="rectangle"
          selectedMotivation="highlighting"
          pageLayout="scroll"
        />
      );

      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });
      io.fire([1]);
      await waitFor(() => expect(mountedPages()).toEqual([1]));
      // Drawing still works in the column: the container is the page's own.
      expect(document.querySelector('.semiont-pdf-annotation-canvas__container'))
        .toHaveAttribute('data-drawing-mode', 'rectangle');
    });

    // S4. A strip of proportional rectangles — one per page, current
    // highlighted, click to jump. Deliberately NOT thumbnails: it needs no
    // rasterization, only the page count and the aspect ratio S1b already
    // measures, so it costs nothing next to the document itself. It answers
    // "where am I in this document", which neither the pager nor the
    // scrollbar does.
    test('renders one strip rectangle per page, marking the current one', async () => {
      const io = stubIntersectionObserver();
      scannedDoc();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });

      const ticks = () => document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page');
      await waitFor(() => expect(ticks()).toHaveLength(5));

      io.fire([3, 4]);
      await waitFor(() => {
        expect(document.querySelector('[aria-current="page"]')).toHaveAttribute('data-page', '3');
      });
    });

    test('clicking a strip rectangle jumps to that page', async () => {
      const io = stubIntersectionObserver();
      scannedDoc();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')).toHaveLength(5);
      });
      io.fire([1]);

      const tick4 = document.querySelector('.semiont-pdf-annotation-canvas__strip-page[data-page="4"]')!;
      fireEvent.click(tick4);

      expect(scrollIntoView).toHaveBeenCalled();
    });

    // S1a. Arrow keys step pages. The guards are the substance: a viewer that
    // steals arrow keys from a text field is worse than one with no shortcut.
    test('PageUp/PageDown step pages; Up/Down are left to scroll', async () => {
      // The convention every mainstream viewer follows (Preview, Chrome's PDF
      // viewer, Acrobat): PageUp/PageDown jump a page, Up/Down scroll finely.
      // Taking Up/Down would leave no keyboard way to reach the bottom of a
      // page taller than the viewport.
      const io = stubIntersectionObserver();
      scannedDoc();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });
      io.fire([2]);
      await waitFor(() => expect(mountedPages()).toEqual([2]));

      scrollIntoView.mockClear();
      fireEvent.keyDown(window, { key: 'PageDown' });
      expect(scrollIntoView).toHaveBeenCalled();

      scrollIntoView.mockClear();
      fireEvent.keyDown(window, { key: 'PageUp' });
      expect(scrollIntoView).toHaveBeenCalled();

      // Up/Down belong to the scroller, not to us.
      scrollIntoView.mockClear();
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      fireEvent.keyDown(window, { key: 'ArrowUp' });
      expect(scrollIntoView).not.toHaveBeenCalled();

      // The same guard as the horizontal pair: never steal from a text field.
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      scrollIntoView.mockClear();
      fireEvent.keyDown(input, { key: 'PageDown' });
      expect(scrollIntoView).not.toHaveBeenCalled();
      input.remove();
    });

    test('Left/Right step pages, and never steal keys from a text field', async () => {
      const io = stubIntersectionObserver();
      scannedDoc();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });
      io.fire([1]);
      await waitFor(() => expect(mountedPages()).toEqual([1]));

      scrollIntoView.mockClear();
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(scrollIntoView).toHaveBeenCalled();

      // Typing in an input must not page the document underneath it.
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      scrollIntoView.mockClear();
      fireEvent.keyDown(input, { key: 'ArrowRight' });
      expect(scrollIntoView).not.toHaveBeenCalled();
      input.remove();
    });

    test('focus follows the current page when the strip owns focus', async () => {
      // Reported: click a page in the strip, then arrow away — the focus ring
      // stays behind on the clicked rectangle while the current-page marker
      // moves, so two rectangles claim to be "here". (The ring only appears
      // after the arrow press because that is when the browser switches to
      // keyboard modality and the clicked button starts matching
      // :focus-visible.) Focus must travel with the current page — but ONLY
      // when the strip already had it, so scrolling with the mouse never
      // snatches focus away from whatever the reader was doing.
      const io = stubIntersectionObserver();
      scannedDoc();
      Element.prototype.scrollIntoView = vi.fn();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')).toHaveLength(5);
      });
      io.fire([1]);
      await waitFor(() => expect(mountedPages()).toEqual([1]));

      const tick = (page: number) =>
        document.querySelector(`.semiont-pdf-annotation-canvas__strip-page[data-page="${page}"]`) as HTMLButtonElement;

      tick(2).focus();
      fireEvent.click(tick(2));
      io.fire([3]);

      await waitFor(() => expect(tick(3)).toHaveAttribute('aria-current', 'page'));
      expect(document.activeElement).toBe(tick(3));
    });

    test('the strip is one tab stop, not one per page', async () => {
      // A 400-page document must not put 400 stops in the tab order. The
      // ARIA pattern: the current item is tabbable, the rest are reachable
      // with arrows (which already page the document).
      const io = stubIntersectionObserver();
      scannedDoc();
      Element.prototype.scrollIntoView = vi.fn();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')).toHaveLength(5);
      });
      io.fire([1]);

      const tabbable = [...document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')]
        .filter((el) => (el as HTMLElement).tabIndex === 0);
      expect(tabbable).toHaveLength(1);
      expect(tabbable[0]).toHaveAttribute('data-page', '1');
    });

    test('the strip runs along the same axis as the scrolling, beside the column', async () => {
      // Pages scroll vertically, so a horizontal strip reads across a
      // direction the document does not move in. The strip's axis follows the
      // scroll axis — which is also what makes horizontal scrolling (a later
      // phase) a change of one value rather than a second layout.
      const io = stubIntersectionObserver();
      scannedDoc();
      Element.prototype.scrollIntoView = vi.fn();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')).toHaveLength(5);
      });
      io.fire([1]);

      const column = document.querySelector('.semiont-pdf-annotation-canvas__column')!;
      const strip = document.querySelector('.semiont-pdf-annotation-canvas__strip')!;

      // One axis, declared in one place, read by both.
      expect(column).toHaveAttribute('data-axis', 'vertical');
      expect(strip).toHaveAttribute('data-axis', 'vertical');
      // Tells assistive tech which arrow keys apply to the strip.
      expect(strip).toHaveAttribute('aria-orientation', 'vertical');
      // The strip leads: it hugs the left edge of the content, the
      // conventional place for a page rail (Preview, Acrobat), and the
      // reader's eye finds it before the page rather than after it.
      expect(strip.nextElementSibling).toBe(column);
      expect(strip.parentElement).toHaveClass('semiont-pdf-annotation-canvas__viewport');
    });

    test('each strip rectangle shows its page number', async () => {
      // At 70 pages the rectangles are indistinguishable from one another —
      // the strip shows position but not WHICH page, which is most of what a
      // reader wants from it on a long document.
      const io = stubIntersectionObserver();
      scannedDoc();
      Element.prototype.scrollIntoView = vi.fn();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')).toHaveLength(5);
      });
      io.fire([1]);

      const tick = (page: number) =>
        document.querySelector(`.semiont-pdf-annotation-canvas__strip-page[data-page="${page}"]`)!;
      expect(tick(1)).toHaveTextContent('1');
      expect(tick(5)).toHaveTextContent('5');

      // The accessible name keeps the context the bare digit loses, and
      // still contains the visible text (WCAG 2.5.3 Label in Name).
      expect(tick(5)).toHaveAttribute('aria-label', expect.stringContaining('5'));
    });


    test('the column does not add a second scrollbar inside the scrolling pane', async () => {
      // The strip and a nested column scrollbar were two controls for one
      // movement. The pane the viewer sits in already scrolls (flex: 1;
      // min-height: 0), so the column must not declare a viewport-relative
      // height of its own — that is what produced scroll-within-scroll.
      const io = stubIntersectionObserver();
      scannedDoc();
      Element.prototype.scrollIntoView = vi.fn();

      render(
        <PdfAnnotationCanvas resourceUri="res-1"
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });
      io.fire([1]);

      // jsdom applies no stylesheet, so assert the CONTRACT the CSS keys off:
      // the column declares the axis but claims no scroll role of its own.
      const column = document.querySelector('.semiont-pdf-annotation-canvas__column')!;
      expect(column).toHaveAttribute('data-axis', 'vertical');
      expect(column).not.toHaveAttribute('data-scroller');
      // The strip is the one that scrolls independently, and silently.
      expect(document.querySelector('.semiont-pdf-annotation-canvas__strip'))
        .toHaveAttribute('data-scroller', 'true');
    });

    test('the indicator reports a page the reader can SEE, not a preloaded one', async () => {
      // The mount window deliberately reaches a viewport beyond the view
      // (PRELOAD_MARGIN) so pages arrive early. Deriving the current page
      // from that same set makes the indicator name a page that is still
      // off-screen — it must come from actual visibility.
      const io = stubIntersectionObserver();
      scannedDoc();
      Element.prototype.scrollIntoView = vi.fn();

      render(
        <PdfAnnotationCanvas resourceUri="res-1" pdfUrl={mockPdfUrl}
          drawingMode={null} pageLayout="scroll" />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });

      // Pages 1-3 are within the preload window; only 3 is actually on screen.
      io.fire([1, 2, 3]);
      io.fireOnscreen([3]);

      await waitFor(() => {
        expect(document.querySelector('[aria-current="page"]')).toHaveAttribute('data-page', '3');
      });
    });

    test('paged navigation does not carry one page\'s state onto the next', async () => {
      // In the paged layout a single PdfPageView is reused as `pageNumber`
      // changes, so its state survives the switch: the previous page's raster
      // shows briefly under the new page's overlay, a drag could quote the
      // previous page's text, and a load failure sticks forever because
      // nothing clears it. Each page is a different thing and must mount as one.
      // Reject by PAGE, not by call order: the parent also calls getPage(1)
      // to measure the document's shape, so a `...Once` rejection would be
      // consumed there and never reach the page view.
      const failingDoc = {
        numPages: 3,
        getPage: vi.fn((n: number) => (n === 1
          ? Promise.reject(new Error('page 1 is broken'))
          : Promise.resolve(mockPage(MOCK_TEXT_ITEMS)))),
      };
      vi.mocked(loadPdfDocument).mockResolvedValueOnce(
        failingDoc as unknown as Awaited<ReturnType<typeof loadPdfDocument>>,
      );

      render(
        <PdfAnnotationCanvas resourceUri="res-1" pdfUrl={mockPdfUrl} drawingMode={null} />
      );

      await waitFor(() => {
        expect(document.querySelector('.semiont-pdf-annotation-canvas__error')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /next/i }));

      // Page 2 loads fine; the failure belonged to page 1 and must not persist.
      await waitFor(() => {
        expect(document.querySelector('.semiont-pdf-annotation-canvas__error')).not.toBeInTheDocument();
      });
    });

    test('without IntersectionObserver every page mounts — degraded, not broken', async () => {
      // The virtualization is an optimization, not a correctness requirement.
      // An environment without the observer must show the whole document
      // rather than nothing.
      scannedDoc();
      vi.stubGlobal('IntersectionObserver', undefined);
      Element.prototype.scrollIntoView = vi.fn();

      render(
        <PdfAnnotationCanvas resourceUri="res-1" pdfUrl={mockPdfUrl}
          drawingMode={null} pageLayout="scroll" />
      );

      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__image')).toHaveLength(5);
      });
    });

    test('a failed map fetch is not cached — the next page retries', async () => {
      // Answers cache, including "no map". A transport failure must not, or
      // one bad moment pins the whole document to geometry-only.
      const io = stubIntersectionObserver();
      scannedDoc();
      Element.prototype.scrollIntoView = vi.fn();

      const resourceAnchoredText = vi.fn()
        .mockRejectedValueOnce(new Error('transport down'))
        .mockResolvedValue({ text: 'later', items: [] });
      const session = {
        client: { beckon: { hover: vi.fn() }, browse: { resourceAnchoredText } },
      } as unknown as import('@semiont/sdk').SemiontSession;

      render(
        <PdfAnnotationCanvas resourceUri="res-1" pdfUrl={mockPdfUrl}
          drawingMode={null} pageLayout="scroll" session={session} />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });

      io.fire([1]);
      await waitFor(() => expect(resourceAnchoredText).toHaveBeenCalledTimes(1));

      io.fire([2]);
      await waitFor(() => expect(resourceAnchoredText).toHaveBeenCalledTimes(2));
    });

    test('the pager still works in the column, and modifiers are left alone', async () => {
      const io = stubIntersectionObserver();
      scannedDoc();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;

      render(
        <PdfAnnotationCanvas resourceUri="res-1" pdfUrl={mockPdfUrl}
          drawingMode={null} pageLayout="scroll" />
      );
      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
      });
      io.fire([3]);
      await waitFor(() => {
        expect(document.querySelector('[aria-current="page"]')).toHaveAttribute('data-page', '3');
      });

      scrollIntoView.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /previous/i }));
      expect(scrollIntoView).toHaveBeenCalled();

      // Cmd/Ctrl/Alt + arrow belongs to the browser and the OS.
      scrollIntoView.mockClear();
      fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });
      fireEvent.keyDown(window, { key: 'PageDown', ctrlKey: true });
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    test('keeps the paged layout when no layout is requested', async () => {
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
      expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(0);
      expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    });
  });

  // PDF-CONTINUOUS-SCROLL S3. The viewer chrome was the last hardcoded-English
  // surface in this component: Previous/Next, the page indicator, and both
  // failure lines. The mock translation manager echoes "<namespace>.<key>",
  // so asserting the echo proves the string came from translations rather
  // than from a literal that happens to read the same in English.
  describe('viewer chrome', () => {
    const renderTranslated = (ui: React.ReactElement) =>
      render(<TranslationProvider translationManager={defaultMocks.translationManager}>{ui}</TranslationProvider>);

    test('takes its controls and page indicator from translations', async () => {
      renderTranslated(
        <PdfAnnotationCanvas resourceUri="res-1" pdfUrl={mockPdfUrl} drawingMode={null} />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'PdfViewer.previous' })).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'PdfViewer.next' })).toBeInTheDocument();
      expect(screen.getByText(/PdfViewer\.pageOf/)).toBeInTheDocument();
      expect(screen.queryByText('Previous')).not.toBeInTheDocument();
      expect(screen.queryByText(/^Page 1 of 3$/)).not.toBeInTheDocument();
    });

    test('announces page changes — a silent indicator is invisible to a screen reader', async () => {
      renderTranslated(
        <PdfAnnotationCanvas resourceUri="res-1" pdfUrl={mockPdfUrl} drawingMode={null} />
      );

      await waitFor(() => {
        expect(document.querySelector('.semiont-pdf-annotation-canvas__page-info')).toBeInTheDocument();
      });
      const indicator = document.querySelector('.semiont-pdf-annotation-canvas__page-info')!;
      expect(indicator).toHaveAttribute('aria-live', 'polite');
      // The pager is a navigation landmark, not loose buttons in the page.
      expect(screen.getByRole('navigation')).toBeInTheDocument();
    });
  });
});
