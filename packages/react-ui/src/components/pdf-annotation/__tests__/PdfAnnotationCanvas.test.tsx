/**
 * PdfAnnotationCanvas Component Tests
 *
 * Tests for PDF annotation canvas component including:
 * - Rendering states (loading, error, success)
 * - Page navigation controls
 * - Annotation display
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PdfAnnotationCanvas } from '../PdfAnnotationCanvas';
import { TranslationProvider } from '../../../contexts/TranslationContext';
import { defaultMocks, renderInEnglish } from '../../../test-utils';
import { resourceId, annotationId, parseFragmentSelector } from '@semiont/core';
import { pdfToCanvasCoordinates } from '../../../lib/pdf-coordinates';
import { loadPdfDocument, renderPdfPageToDataUrl } from '../../../lib/browser-pdfjs';

import type { Annotation, AnchoredTextAnswer } from '@semiont/core';

// The document's anchored text, as Semiont serves it: the canvas asks for it
// and reads no page's text itself. Geometry is PDF points, bottom-left origin:
// "Hello world" sits on one line of page 1 at y=700, "elsewhere" a hundred
// points below it.
const SERVED_TEXT: AnchoredTextAnswer = {
  kind: 'extracted',
  method: 'pdf-text-layer',
  text: 'Hello world\nelsewhere\n',
  items: [
    { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },
    { start: 6, end: 11, page: 1, x: 106, y: 700, width: 32, height: 12 },
    { start: 12, end: 21, page: 1, x: 72, y: 600, width: 54, height: 12 },
  ],
};

// A pdf.js page as the canvas uses one: a viewport to measure and a render to
// draw. It has no `getTextContent` — a canvas that asked for one would throw.
const mockPage = () => ({
  getViewport: vi.fn().mockReturnValue({
    width: 612,
    height: 792,
    scale: 1.0,
    rotation: 0
  }),
  render: vi.fn().mockReturnValue({
    promise: Promise.resolve()
  }),
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
  let observeCalls = 0;
  class FakeIO {
    constructor(private cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      margins.set(cb, options?.rootMargin ?? '0px');
    }
    observe(el: Element) {
      observeCalls++;
      observed.push({ el, cb: this.cb });
    }
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

  /** Deliver one entry per observed slot to the observers `match` selects:
   *  intersecting for `visible`, not for the rest. Refuses a visible page no
   *  selected observer has registered — that entry would reach nobody, and the
   *  test would only find out a second later, from an empty mount list. */
  function fireFor(visible: number[], match: (rootMargin: string) => boolean) {
    const byCb = new Map<IntersectionObserverCallback, IntersectionObserverEntry[]>();
    const reached = new Set<number>();
    for (const { el, cb } of observed) {
      if (!match(margins.get(cb) ?? '0px')) continue;
      const page = Number((el as HTMLElement).dataset.page);
      reached.add(page);
      byCb.set(cb, [...(byCb.get(cb) ?? []), {
        target: el, isIntersecting: visible.includes(page),
      } as unknown as IntersectionObserverEntry]);
    }
    const unreached = visible.filter((page) => !reached.has(page));
    if (unreached.length > 0) {
      throw new Error(
        `fire([${visible}]): no observer has registered page ${unreached} yet — wait on io.observedPages() first`,
      );
    }
    act(() => { for (const [cb, entries] of byCb) cb(entries, {} as IntersectionObserver); });
  }

  /** Only the bare observer — what the reader can actually see. */
  function fireOnscreen(visible: number[]) {
    fireFor(visible, (m) => m === '0px');
  }

  /**
   * Pages currently registered with an observer, deduped. The slots — and the
   * strip, which lands in the same commit — reach the DOM one effect BEFORE
   * `observe()` runs on them, so a wait on the DOM can pass with nothing
   * registered. Whether the test then fires before or after the effect is a
   * race between React's scheduler and waitFor's closing 0ms timer, which CI
   * load decides. Wait on this instead. (Both observers are created in the
   * same effect pass, so a page appearing here means both have it.)
   */
  function observedPages(): number[] {
    const pages = new Set(observed.map(({ el }) => Number((el as HTMLElement).dataset.page)));
    return [...pages].sort((a, b) => a - b);
  }

  return {
    fireOnscreen,
    observedPages,
    /** Every `observe()` so far, re-registrations included — `observedPages`
     *  cannot see an unobserve followed by an observe of the same slot. */
    observeCalls: () => observeCalls,
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
    // ...and prototype spies must not leak into later tests in THIS file.
    vi.restoreAllMocks();
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
    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
        pdfUrl={mockPdfUrl}
        drawingMode={null}
      />
    );

    expect(screen.getByText(/loading pdf/i)).toBeInTheDocument();
  });

  test('renders page navigation controls after loading', async () => {
    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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
    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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
    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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

    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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

  test('passes the annotation rect as browse.click second argument', async () => {
    const click = vi.fn();
    const session = {
      client: {
        browse: { click, resourceAnchoredText: vi.fn().mockResolvedValue(SERVED_TEXT) },
        beckon: { hover: vi.fn() },
      },
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

    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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
    const anchorRect = click.mock.calls[0]?.[1];
    expect(anchorRect).toBeDefined();
    expect(typeof anchorRect.width).toBe('number');
  });

  test('drawing-path hit-test emits browse.click with the annotation viewport rect', async () => {
    // In drawing mode, a sub-10px click on an existing annotation
    // goes through the mouse-up hit-test, which owns the PDF→display
    // coordinate transform. Expected rect computed with the same lib
    // functions the component uses (scale is 1: display 612×792 == page).
    const click = vi.fn();
    const session = {
      client: {
        browse: { click, resourceAnchoredText: vi.fn().mockResolvedValue(SERVED_TEXT) },
        beckon: { hover: vi.fn() },
      },
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

    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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
    // The hit-test runs on a gesture the canvas takes, and it takes one only
    // while it holds the document's text.
    await waitFor(() => {
      expect(document.querySelector('.semiont-pdf-annotation-canvas')).toHaveAttribute('data-annotate-deferred', 'false');
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
    expect(click.mock.calls[0]?.[1]).toMatchObject({
      left: displayRect.x,
      top: displayRect.y,
      width: displayRect.width,
      height: displayRect.height,
    });
  });

  /**
   * Drives the drag → mark.request path far enough to inspect the selector,
   * on a document for which Semiont answers `answer`: an answer that gives
   * the canvas the text, since the drag waits until the canvas holds it.
   * `drag` is in canvas pixels; at scale 1 with a 612×792 page these are also
   * display coordinates, since jsdom's getBoundingClientRect returns zeros.
   */
  async function drawRectangle(
    drag: { fromX: number; fromY: number; toX: number; toY: number },
    answer: AnchoredTextAnswer,
    onPage = 1,
  ) {
    const request = vi.fn();
    const session = {
      client: {
        mark: { request },
        beckon: { hover: vi.fn() },
        browse: { resourceAnchoredText: vi.fn().mockResolvedValue(answer) },
      },
    } as unknown as import('@semiont/sdk').SemiontSession;

    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
        pdfUrl={mockPdfUrl}
        drawingMode="rectangle"
        selectedMotivation="highlighting"
        session={session}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });
    for (let page = 2; page <= onPage; page++) {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    }

    const pageImage = () =>
      document.querySelector(`.semiont-pdf-annotation-canvas__image[alt="PDF page ${onPage}"]`);
    await waitFor(() => {
      expect(pageImage()).toBeInTheDocument();
    });

    const img = pageImage() as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 612, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 792, configurable: true });
    fireEvent.load(img);

    await waitFor(() => {
      expect(document.querySelector('.semiont-pdf-annotation-canvas')).toHaveAttribute('data-annotate-deferred', 'false');
    });

    const container = document.querySelector('.semiont-pdf-annotation-canvas__container')!;
    fireEvent.mouseDown(container, { clientX: drag.fromX, clientY: drag.fromY });
    fireEvent.mouseMove(container, { clientX: drag.toX, clientY: drag.toY });
    fireEvent.mouseUp(container, { clientX: drag.toX, clientY: drag.toY });

    return request;
  }

  /** A box a little larger than a line of text: what a hand draws around it. */
  function aroundLine(line: { page: number; x: number; y: number; width: number; height: number }) {
    const box = pdfToCanvasCoordinates(line, 792, 1.0);
    return {
      fromX: box.x - 2,
      fromY: box.y - 2,
      toX: box.x + box.width + 8,
      toY: box.y + box.height + 4,
    };
  }

  // The "Hello world" line: PDF y=700..712 flips to canvas y=80..92 on a
  // 792pt page.
  const HELLO_WORLD_LINE = { page: 1, x: 72, y: 700, width: 66, height: 12 };

  // A hand-drawn rectangle that stores geometry and nothing else shows blank
  // in every panel that quotes an annotation.
  test('a drawn rectangle carries the text it was drawn around', async () => {
    const request = await drawRectangle(aroundLine(HELLO_WORLD_LINE), SERVED_TEXT);

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

  // A PDF's text has one producer. This page has a text layer pdf.js could
  // read, and it says something ELSE: a canvas that read it would quote the
  // layer's words, or never ask Semiont at all.
  test('the quote is cut from the served text — pdf.js is never asked for the page\'s text', async () => {
    const getTextContent = vi.fn().mockResolvedValue({
      items: [
        { str: 'words pdf.js read', transform: [1, 0, 0, 1, 72, 700], width: 66, height: 12, hasEOL: true },
      ],
    });
    vi.mocked(loadPdfDocument).mockResolvedValueOnce({
      numPages: 3,
      getPage: vi.fn().mockResolvedValue({ ...mockPage(), getTextContent }),
    } as unknown as Awaited<ReturnType<typeof loadPdfDocument>>);

    const request = await drawRectangle(aroundLine(HELLO_WORLD_LINE), SERVED_TEXT);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][1]).toEqual([
      expect.objectContaining({ type: 'FragmentSelector' }),
      { type: 'TextQuoteSelector', exact: 'Hello world' },
    ]);
    expect(getTextContent).not.toHaveBeenCalled();
  });

  test('a rectangle over blank space carries geometry only', async () => {
    // Between the two lines of text — nothing under the box. An empty-string
    // quote would assert the box was drawn around nothing, so emit no quote.
    const request = await drawRectangle({ fromX: 40, fromY: 120, toX: 200, toY: 150 }, SERVED_TEXT);

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const selector = request.mock.calls[0][1];
    expect(selector).toHaveLength(1);
    expect(selector[0].type).toBe('FragmentSelector');
  });

  // The served text is the whole document's, not a page's: offsets run on
  // from one page into the next, and each run names its page. Both pages
  // here put a line at the same place, so only a run's page decides which
  // line a rectangle quotes. The character that ends page 1's line is one
  // code point and two UTF-16 units, so page 2's offsets are not positions in
  // the JavaScript string: a canvas that sliced the text itself would cut
  // "\nsecon" where the word is "second".
  test('a rectangle on page 2 quotes page 2\'s words out of the whole document\'s text', async () => {
    const request = await drawRectangle(
      aroundLine({ ...HELLO_WORLD_LINE, page: 2 }),
      {
        kind: 'extracted',
        method: 'pdf-text-layer',
        text: 'first \u{1D49C}\nsecond page\n',
        items: [
          { start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 },
          { start: 6, end: 7, page: 1, x: 106, y: 700, width: 32, height: 12 },
          { start: 8, end: 14, page: 2, x: 72, y: 700, width: 30, height: 12 },
          { start: 15, end: 19, page: 2, x: 106, y: 700, width: 32, height: 12 },
        ],
      },
      2,
    );

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][1]).toEqual([
      expect.objectContaining({ type: 'FragmentSelector', value: expect.stringContaining('page=2&viewrect=') }),
      { type: 'TextQuoteSelector', exact: 'second page' },
    ]);
  });

  // The served text is WHOLE-RESOURCE — one artifact covering every page —
  // so a page that asked for it would refetch and re-decode the entire
  // document's geometry on every page turn. On a 400-page document that is
  // the difference between one decode and one per interaction. The canvas
  // holds it once and hands it to each page.
  test('the whole-resource text is asked for once per document, not once per page-turn', async () => {
    const resourceAnchoredText = vi.fn().mockResolvedValue(SERVED_TEXT);
    const session = {
      client: { beckon: { hover: vi.fn() }, browse: { resourceAnchoredText } },
    } as unknown as import('@semiont/sdk').SemiontSession;

    renderInEnglish(
      <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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

    // Three render calls: all three pages loaded.
    await waitFor(() => {
      expect(vi.mocked(renderPdfPageToDataUrl)).toHaveBeenCalledTimes(3);
    });

    expect(resourceAnchoredText).toHaveBeenCalledTimes(1);
  });

  // Browse mode scrolls: every page has a slot so
  // the scrollbar is honest about the document's length, but only a window of
  // pages is MOUNTED — unmounting is what releases a page's raster, so the
  // window IS the memory budget.
  describe('scroll layout (browse mode)', () => {
    const fivePageDoc = () =>
      vi.mocked(loadPdfDocument).mockResolvedValueOnce({
        numPages: 5,
        getPage: vi.fn().mockResolvedValue(mockPage()),
      } as unknown as Awaited<ReturnType<typeof loadPdfDocument>>);

    const mountedPages = () =>
      [...document.querySelectorAll('.semiont-pdf-annotation-canvas__image')]
        .map((img) => Number((img as HTMLImageElement).alt.replace(/\D+/g, '')))
        .sort((a, b) => a - b);

    test('gives every page a slot but mounts only the visible window', async () => {
      const io = stubIntersectionObserver();
      fivePageDoc();

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );

      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });
      // Nothing rasterized before anything is visible.
      expect(mountedPages()).toEqual([]);

      io.fire([1, 2]);
      await waitFor(() => expect(mountedPages()).toEqual([1, 2]));
      expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__slot')).toHaveLength(5);
    });

    test('releases a page that scrolls out of the window', async () => {
      const io = stubIntersectionObserver();
      fivePageDoc();

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });

      io.fire([1, 2]);
      await waitFor(() => expect(mountedPages()).toEqual([1, 2]));

      io.fire([4, 5]);
      await waitFor(() => expect(mountedPages()).toEqual([4, 5]));
    });

    test('a re-render does not re-register the slots with the observers', async () => {
      // A real IntersectionObserver answers every observe() — a re-observe
      // after unobserve included — with a fresh notification. Re-registering
      // the slots on each commit therefore closes a loop: notification →
      // state → render → re-register → notification. In Chromium on an idle
      // 30-page document that is 120 commits/s, 7,200 observe() calls/s.
      // This stub does not notify on observe(), so the loop cannot show here;
      // the re-registration that feeds it can.
      const io = stubIntersectionObserver();
      fivePageDoc();

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });
      const registrations = io.observeCalls();

      io.fire([1, 2]);
      await waitFor(() => expect(mountedPages()).toEqual([1, 2]));

      expect(io.observeCalls()).toBe(registrations);
    });

    test('still asks for the whole-resource text once, across many mounted pages', async () => {
      // Asked once however many page views mount and unmount: the text is
      // the canvas's to hold, and no page asks for it.
      const io = stubIntersectionObserver();
      fivePageDoc();

      const resourceAnchoredText = vi.fn().mockResolvedValue(SERVED_TEXT);
      const session = {
        client: { beckon: { hover: vi.fn() }, browse: { resourceAnchoredText } },
      } as unknown as import('@semiont/sdk').SemiontSession;

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
          session={session}
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });

      io.fire([1, 2, 3]);
      await waitFor(() => expect(mountedPages()).toEqual([1, 2, 3]));
      io.fire([3, 4, 5]);
      await waitFor(() => expect(mountedPages()).toEqual([3, 4, 5]));

      expect(resourceAnchoredText).toHaveBeenCalledTimes(1);
    });

    test('a slot keeps its reserved height when its page mounts', async () => {
      // Releasing the reservation on mount makes the column's total height
      // change on every scroll — the scrollbar jumps and resizes under the
      // cursor. The reservation must survive mounting so the column's
      // geometry never depends on which pages are mounted.
      const io = stubIntersectionObserver();
      fivePageDoc();

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      // The drag lives in the page view, so page identity comes from the
      // component that owns the pixels rather than from a shared `pageNumber`
      // — the invariant that makes a column safe to draw on at all.
      const io = stubIntersectionObserver();
      fivePageDoc();

      const request = vi.fn();
      const session = {
        client: {
          mark: { request },
          beckon: { hover: vi.fn() },
          browse: { resourceAnchoredText: vi.fn().mockResolvedValue(SERVED_TEXT) },
        },
      } as unknown as import('@semiont/sdk').SemiontSession;

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode="rectangle"
          selectedMotivation="highlighting"
          session={session}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });

      io.fire([2, 3]);
      await waitFor(() => expect(mountedPages()).toEqual([2, 3]));
      await waitFor(() => {
        expect(document.querySelector('.semiont-pdf-annotation-canvas')).toHaveAttribute('data-annotate-deferred', 'false');
      });

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
      // The registries are the seam: both ask for the column.
      const io = stubIntersectionObserver();
      fivePageDoc();

      const session = {
        client: {
          beckon: { hover: vi.fn() },
          browse: { resourceAnchoredText: vi.fn().mockResolvedValue(SERVED_TEXT) },
        },
      } as unknown as import('@semiont/sdk').SemiontSession;

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode="rectangle"
          selectedMotivation="highlighting"
          session={session}
          pageLayout="scroll"
        />
      );

      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });
      io.fire([1]);
      await waitFor(() => expect(mountedPages()).toEqual([1]));
      // Drawing still works in the column: the container is the page's own.
      await waitFor(() => {
        expect(document.querySelector('.semiont-pdf-annotation-canvas__container'))
          .toHaveAttribute('data-drawing-mode', 'rectangle');
      });
    });

    // A strip of proportional rectangles — one per page, current
    // highlighted, click to jump. Deliberately NOT thumbnails: it needs no
    // rasterization, only the page count and the aspect ratio the slot
    // reservation already uses, so it costs nothing next to the document
    // itself. It answers "where am I in this document", which neither the
    // pager nor the scrollbar does.
    test('renders one strip rectangle per page, marking the current one', async () => {
      const io = stubIntersectionObserver();
      fivePageDoc();

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });

      const ticks = () => document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page');
      await waitFor(() => expect(ticks()).toHaveLength(5));

      io.fire([3, 4]);
      await waitFor(() => {
        expect(document.querySelector('[aria-current="page"]')).toHaveAttribute('data-page', '3');
      });
    });

    test('the strip sizes its scrollport to the panel that clips it — not the window', async () => {
      // The strip is sticky with a CSS ceiling of 100vh — right when the
      // nearest scroller is the window, a lie inside an inner-scrolled panel:
      // there the strip's scrollport extends below the panel's clip, and
      // `scrollIntoView({block:'nearest'})` considers a tick in that hidden
      // band already in view — the active page vanishes when it crosses the
      // strip's bottom (never the top, whose edges coincide); e.g. a strip
      // scrollport of 126→846 inside a panel of 126→639. So the scrollport is
      // sized to the scroller that actually clips it.
      const io = stubIntersectionObserver();
      fivePageDoc();

      const scroller = document.createElement('div');
      scroller.style.overflowY = 'auto';
      Object.defineProperty(scroller, 'clientHeight', { value: 513, configurable: true });
      document.body.appendChild(scroller);

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />,
        { container: scroller },
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')).toHaveLength(5);
      });
      io.fire([1]);

      const strip = document.querySelector('.semiont-pdf-annotation-canvas__strip') as HTMLElement;
      await waitFor(() => expect(strip.style.maxHeight).toBe('513px'));
    });

    test('clicking a strip rectangle jumps to that page', async () => {
      const io = stubIntersectionObserver();
      fivePageDoc();
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__strip-page')).toHaveLength(5);
      });
      io.fire([1]);

      const tick4 = document.querySelector('.semiont-pdf-annotation-canvas__strip-page[data-page="4"]')!;
      fireEvent.click(tick4);

      expect(scrollIntoView).toHaveBeenCalled();
    });

    // Arrow keys step pages. The guards are the substance: a viewer that
    // steals arrow keys from a text field is worse than one with no shortcut.
    test('PageUp/PageDown step pages; Up/Down are left to scroll', async () => {
      // The convention every mainstream viewer follows (Preview, Chrome's PDF
      // viewer, Acrobat): PageUp/PageDown jump a page, Up/Down scroll finely.
      // Taking Up/Down would leave no keyboard way to reach the bottom of a
      // page taller than the viewport.
      const io = stubIntersectionObserver();
      fivePageDoc();
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      fivePageDoc();
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      // Click a page in the strip, then arrow away: a focus ring that stays
      // behind on the clicked rectangle while the current-page marker moves
      // leaves two rectangles claiming to be "here". (The ring only appears
      // after the arrow press because that is when the browser switches to
      // keyboard modality and the clicked button starts matching
      // :focus-visible.) Focus must travel with the current page — but ONLY
      // when the strip already had it, so scrolling with the mouse never
      // snatches focus away from whatever the reader was doing.
      const io = stubIntersectionObserver();
      fivePageDoc();
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      fivePageDoc();
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      // scroll axis — which is also what would make horizontal scrolling a
      // change of one value rather than a second layout.
      const io = stubIntersectionObserver();
      fivePageDoc();
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      fivePageDoc();
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      // The strip and a nested column scrollbar would be two controls for one
      // movement. The pane the viewer sits in already scrolls (flex: 1;
      // min-height: 0), so the column must not declare a viewport-relative
      // height of its own — that produces scroll-within-scroll.
      const io = stubIntersectionObserver();
      fivePageDoc();
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
          pdfUrl={mockPdfUrl}
          drawingMode={null}
          pageLayout="scroll"
        />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      fivePageDoc();
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")} pdfUrl={mockPdfUrl}
          drawingMode={null} pageLayout="scroll" />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
      });

      // Pages 1-3 are within the preload window; only 3 is actually on screen.
      io.fire([1, 2, 3]);
      io.fireOnscreen([3]);

      await waitFor(() => {
        expect(document.querySelector('[aria-current="page"]')).toHaveAttribute('data-page', '3');
      });
    });

    test('paged navigation does not carry one page\'s state onto the next', async () => {
      // A single PdfPageView reused in the paged layout as `pageNumber`
      // changes would keep its state across the switch: the previous page's
      // raster shows briefly under the new page's overlay, a drag over it
      // would be recorded against the new page, and a load failure sticks
      // forever because nothing clears it. Each page is a different thing and
      // must mount as one.
      // Reject by PAGE, not by call order: the parent also calls getPage(1)
      // to measure the document's shape, so a `...Once` rejection would be
      // consumed there and never reach the page view.
      const failingDoc = {
        numPages: 3,
        getPage: vi.fn((n: number) => (n === 1
          ? Promise.reject(new Error('page 1 is broken'))
          : Promise.resolve(mockPage()))),
      };
      vi.mocked(loadPdfDocument).mockResolvedValueOnce(
        failingDoc as unknown as Awaited<ReturnType<typeof loadPdfDocument>>,
      );

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")} pdfUrl={mockPdfUrl} drawingMode={null} />
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
      fivePageDoc();
      vi.stubGlobal('IntersectionObserver', undefined);
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")} pdfUrl={mockPdfUrl}
          drawingMode={null} pageLayout="scroll" />
      );

      await waitFor(() => {
        expect(document.querySelectorAll('.semiont-pdf-annotation-canvas__image')).toHaveLength(5);
      });
    });

    test('the pager still works in the column, and modifiers are left alone', async () => {
      const io = stubIntersectionObserver();
      fivePageDoc();
      const scrollIntoView = vi
        .spyOn(Element.prototype, 'scrollIntoView')
        .mockImplementation(() => {});

      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")} pdfUrl={mockPdfUrl}
          drawingMode={null} pageLayout="scroll" />
      );
      await waitFor(() => {
        expect(io.observedPages()).toHaveLength(5);
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
      renderInEnglish(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")}
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

  // The viewer chrome is translated: Previous/Next, the page indicator, and
  // both failure lines. The mock translation manager echoes "<namespace>.<key>",
  // so asserting the echo proves the string came from translations rather
  // than from a literal that happens to read the same in English.
  describe('viewer chrome', () => {
    const renderTranslated = (ui: React.ReactElement) =>
      renderInEnglish(<TranslationProvider translationManager={defaultMocks.translationManager}>{ui}</TranslationProvider>);

    test('takes its controls and page indicator from translations', async () => {
      renderTranslated(
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")} pdfUrl={mockPdfUrl} drawingMode={null} />
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
        <PdfAnnotationCanvas resourceUri={resourceId("res-1")} pdfUrl={mockPdfUrl} drawingMode={null} />
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
