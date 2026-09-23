'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation } from '@semiont/core';
import { estimateSlotHeight } from './estimate-slot-height';
import { useAnchoredText } from './use-anchored-text';
import { PdfPageView } from './PdfPageView';
import { useTranslations } from '../../contexts/TranslationContext';
import type { SemiontSession } from '@semiont/sdk';
import type { SelectionMotivation } from '../annotation/AnnotateToolbar';
import { loadPdfDocument, type PDFDocumentProxy } from '../../lib/browser-pdfjs';
import './PdfAnnotationCanvas.css';

export type DrawingMode = 'rectangle' | 'circle' | 'polygon' | null;

/**
 * How the document's pages are laid out.
 *
 * `paged` is one page with Previous/Next. `scroll` is a virtualized column:
 * every page gets a slot so the scrollbar tells the truth about the
 * document's length, but only the pages near the viewport are mounted.
 *
 * Declared explicitly rather than inferred from `drawingMode`, which does NOT
 * distinguish the modes — AnnotateView passes `drawingMode={null}` whenever no
 * motivation is selected, so keying layout on it would flip a reader between
 * scrolling and paged views as they picked up and put down a tool.
 * See .plans/PDF-CONTINUOUS-SCROLL.md D3.
 */
export type PageLayout = 'paged' | 'scroll';

/** How far outside the viewport a page starts loading, and stays loaded. */
const PRELOAD_MARGIN = '100% 0px';

/** Width of one page rectangle in the strip, in CSS px. Height follows the
 *  document's own aspect ratio, so the strip looks like the document — wide
 *  enough to carry a three-digit page number, which is what makes the strip
 *  useful rather than merely positional on a long document. */
const STRIP_PAGE_WIDTH = 30;

/**
 * The axis pages advance along.
 *
 * ONE source for two consumers: the column scrolls along it, and the page
 * strip runs parallel to it. A strip that ran across the scroll direction
 * would read as a control for a movement the document does not make.
 *
 * Constant today because scrolling is vertical. The horizontal-scrolling
 * setting turns this into a value read from preferences — both consumers
 * follow automatically, which is the point of routing them through one name.
 */
const SCROLL_AXIS: 'vertical' | 'horizontal' = 'vertical';

/**
 * Scroll an element into view where the environment supports it.
 *
 * Same posture as this file's guarded observers: jsdom implements no layout
 * and therefore no `scrollIntoView`, and a viewer that throws in a test
 * harness (or an exotic embedding host) is worse than one that simply does
 * not scroll.
 */
function scrollElementIntoView(el: Element | null | undefined, options: ScrollIntoViewOptions): void {
  if (typeof el?.scrollIntoView === 'function') el.scrollIntoView(options);
}

/**
 * Get color for annotation based on motivation
 */

interface PdfAnnotationCanvasProps {
  pdfUrl: string;
  /** The '@id' of the annotated resource — stamped as `source` on mark:requested (multi-viewer routing). */
  resourceUri: string;
  existingAnnotations?: Annotation[];
  drawingMode: DrawingMode;
  selectedMotivation?: SelectionMotivation | null;
  session?: SemiontSession | null | undefined;
  hoveredAnnotationId?: string | null;
  selectedAnnotationId?: string | null;
  hoverDelayMs?: number;
  /** `paged` (default) or the virtualized `scroll` column. See `PageLayout`. */
  pageLayout?: PageLayout;
}

/**
 * PDF annotation canvas with page navigation and rectangle drawing
 *
 * @emits browse:click - Annotation clicked on PDF. Payload: { annotationId: string, motivation: Motivation }
 * @emits mark:requested - New annotation drawn on PDF. Payload: { selector: [FragmentSelector, TextQuoteSelector?], motivation: SelectionMotivation } — the quote is the text under the rectangle, omitted when the page has no text layer
 * @emits beckon:hover - Annotation hovered or unhovered. Payload: { annotationId: string | null }
 */
export function PdfAnnotationCanvas({
  pdfUrl,
  resourceUri,
  existingAnnotations = [],
  drawingMode,
  selectedMotivation,
  session,
  hoveredAnnotationId,
  selectedAnnotationId,
  hoverDelayMs = 150,
  pageLayout = 'paged'
}: PdfAnnotationCanvasProps) {
  // PDF state
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const t = useTranslations('PdfViewer');
  /**
   * Page 1's shape, for reserving space in slots that have not mounted yet:
   * its aspect ratio and its raster width. NOT its raster height — the image
   * renders under `max-width: 100%; height: auto`, so its displayed height
   * depends on the column's width, and reserving raster pixels made the
   * column's height lurch on every mount (S1b).
   * See .plans/PDF-CONTINUOUS-SCROLL.md D4 + S1b.
   */
  const [pageShape, setPageShape] = useState<{ aspect: number; rasterWidth: number } | null>(null);
  /** Measured inner width of the column — the other half of the reservation. */
  const [columnWidth, setColumnWidth] = useState<number | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [scale] = useState(1.5); // Fixed scale for better quality

  /** Pages currently intersecting the viewport (plus the preload margin). */
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  /** Pages genuinely in view — observed with NO preload margin, so it answers
   *  "what is the reader looking at" rather than "what should be loaded".
   *  Drives the indicator and the rail; never the mount window. */
  const [onscreenPages, setOnscreenPages] = useState<Set<number>>(new Set());
  const slotRefs = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const onscreenRef = useRef<IntersectionObserver | null>(null);

  // Load PDF document on mount
  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      try {
        setIsLoading(true);
        setErrorKey(null);

        const doc = await loadPdfDocument(pdfUrl);

        if (cancelled) return;

        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setIsLoading(false);

        // One extra getPage, for slot sizing (D4). Failure is not fatal:
        // unsized slots still scroll, just less faithfully.
        try {
          const first = await doc.getPage(1);
          if (cancelled) return;
          const natural = first.getViewport({ scale: 1.0 });
          setPageShape({
            aspect: natural.height / natural.width,
            rasterWidth: first.getViewport({ scale }).width,
          });
        } catch {
          /* leave unsized — an unsized slot is stable; a mis-sized one moves */
        }
      } catch (err) {
        if (cancelled) return;

        console.error('Error loading PDF:', err);
        setErrorKey('loadFailed');
        setIsLoading(false);
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
    };
  }, [pdfUrl, scale]);

  /**
   * The server-derived map, fetched once per document rather than once per
   * page (PERSIST-ANCHORS P4). The map is WHOLE-RESOURCE — one artifact
   * covering every page — so re-reading it per page meant a full refetch and
   * re-decode on every page turn; on a 400-page scan that is one decode per
   * interaction instead of one per document. Living on the parent is also
   * what lets a scrolling column mount many pages against a single fetch.
   *
   * The cache holds the in-flight promise so concurrent page loads share one
   * fetch. TERMINAL answers cache — "no map", "unknown" and a stored decline
   * are definitive — but the wire names retryability in the kind itself
   * (AnchoredTextAbsent, ANNOTATE-DEFERS-ON-NOT-YET P1/D4): `not-yet` means
   * the Smelter has not settled this content generation and the caller should
   * come back, so it clears the entry the way a transport failure always has.
   * Pinning it was how a scan opened mid-smelt stayed mapless for the whole
   * mount — every annotation drawn on it permanently mute.
   *
   * The settled kind rides on the cache entry: the answer, not just the map,
   * is the parent's fact (P2 lifts it into state to gate Annotate).
   */
  const { anchoredEpoch, annotateDeferred, fetchResourceAnchored } =
    useAnchoredText(session, resourceUri);

  // The column's width decides every page's displayed height, so the
  // reservation cannot be computed without it.
  useEffect(() => {
    if (pageLayout !== 'scroll') return;
    const measure = () => {
      if (columnRef.current) setColumnWidth(columnRef.current.clientWidth);
    };
    measure();
    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(measure);
      if (columnRef.current) observer.observe(columnRef.current);
    } catch {
      window.addEventListener('resize', measure);
    }
    return () => {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', measure);
    };
  }, [pageLayout]);

  const slotHeight = estimateSlotHeight(columnWidth, pageShape?.rasterWidth ?? null, pageShape?.aspect ?? null)
    // Before the column has been measured there is still a sane reservation:
    // the raster's own height. Wrong in a narrow column, but every slot is
    // wrong by the SAME amount, so the column is at least internally
    // consistent until the first measurement lands.
    ?? (pageShape ? Math.round(pageShape.rasterWidth * pageShape.aspect) : null);

  // The mount window. Slots report their own visibility; a page is mounted
  // while its slot intersects (widened by PRELOAD_MARGIN so the next page is
  // ready before it is reached), and unmounting is what frees its raster.
  useEffect(() => {
    if (pageLayout !== 'scroll' || numPages === 0) return;

    let observer: IntersectionObserver | null = null;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          setVisiblePages((prev) => {
            const next = new Set(prev);
            for (const entry of entries) {
              const page = Number((entry.target as HTMLElement).dataset.page);
              if (!page) continue;
              if (entry.isIntersecting) next.add(page);
              else next.delete(page);
            }
            return next;
          });
        },
        { rootMargin: PRELOAD_MARGIN },
      );
    } catch {
      // No IntersectionObserver: mount every page rather than none. Correct,
      // simply not virtualized — the same posture as the ResizeObserver
      // fallback in PdfPageView.
      setVisiblePages(new Set(Array.from({ length: numPages }, (_, i) => i + 1)));
      return;
    }

    observerRef.current = observer;
    for (const el of slotRefs.current.values()) observer.observe(el);

    // A SECOND observer, with no preload margin, answers a different question:
    // which pages the reader can actually see. Two observers rather than one
    // set doing both jobs, because widening the mount window must never move
    // the page indicator.
    let onscreen: IntersectionObserver | null = null;
    try {
      onscreen = new IntersectionObserver((entries) => {
        setOnscreenPages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.page);
            if (!page) continue;
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        });
      });
      onscreenRef.current = onscreen;
      for (const el of slotRefs.current.values()) onscreen.observe(el);
    } catch {
      // Without an observer there is no notion of "on screen"; fall back to
      // page 1 so the indicator names something rather than nothing.
      setOnscreenPages(new Set([1]));
    }

    return () => {
      observer.disconnect();
      observerRef.current = null;
      onscreen?.disconnect();
      onscreenRef.current = null;
    };
  }, [pageLayout, numPages]);

  const registerSlot = useCallback((page: number) => (el: HTMLDivElement | null) => {
    const previous = slotRefs.current.get(page);
    if (previous) {
      observerRef.current?.unobserve(previous);
      onscreenRef.current?.unobserve(previous);
    }
    if (el) {
      slotRefs.current.set(page, el);
      observerRef.current?.observe(el);
      onscreenRef.current?.observe(el);
    } else {
      slotRefs.current.delete(page);
    }
  }, []);

  /** Keeps the current page's rectangle in view as the reader scrolls. */
  const currentTickRef = useRef<HTMLButtonElement>(null);

  const scrollToPage = useCallback((page: number) => {
    scrollElementIntoView(slotRefs.current.get(page), { block: 'start' });
  }, []);

  // In the column the reader decides which page they are on by scrolling, so
  // the indicator reports rather than controls: the topmost page actually ON
  // SCREEN. NOT `visiblePages` — that set is deliberately widened by
  // PRELOAD_MARGIN to mount pages before they are reached, so reading it here
  // would name a page still a viewport away.
  const currentPage = pageLayout === 'scroll'
    ? (onscreenPages.size > 0 ? Math.min(...onscreenPages) : 1)
    : pageNumber;

  /**
   * Left/Right step pages (S1a).
   *
   * Bound to the window rather than a focusable wrapper so it works without
   * the reader hunting for the viewer's focus — but that reach is exactly why
   * the guards matter more than the feature: a viewer that eats arrow keys
   * while someone is editing an annotation body, or mid-drag, is worse than
   * one with no shortcut at all.
   */
  useEffect(() => {
    if (numPages === 0) return;
    const BACK = ['ArrowLeft', 'PageUp'];
    const FORWARD = ['ArrowRight', 'PageDown'];
    const onKeyDown = (e: KeyboardEvent) => {
      // PageUp/PageDown jump a page; Left/Right do too, because they have no
      // native meaning in a vertical layout so taking them costs nothing.
      //
      // Up/Down are deliberately NOT here. They are the scroller's fine
      // movement, and a page can be taller than the viewport — taking them
      // would leave no keyboard way to reach the bottom of one. This is the
      // split Preview, Chrome's PDF viewer and Acrobat all use.
      if (!BACK.includes(e.key) && !FORWARD.includes(e.key)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // browser/OS navigation
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;

      const next = FORWARD.includes(e.key) ? currentPage + 1 : currentPage - 1;
      if (next < 1 || next > numPages) return;
      e.preventDefault();
      if (pageLayout === 'scroll') scrollToPage(next);
      else setPageNumber(next);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [numPages, currentPage, pageLayout, scrollToPage]);

  const stripRef = useRef<HTMLDivElement>(null);

  // The strip's CSS scrollport ceiling is 100vh — right when the nearest
  // scroller is the window, a lie inside an inner-scrolled panel: the sticky
  // strip then extends below the panel's clip, and `nearest` (below) considers
  // a tick in that hidden band already in view, so the active page vanished
  // whenever it crossed the strip's bottom (never the top, whose edges
  // coincide). Size the scrollport to the scroller that actually clips it;
  // with no such scroller the CSS ceiling stands.
  useEffect(() => {
    const strip = stripRef.current;
    if (pageLayout !== 'scroll' || !strip) return;
    let scroller: HTMLElement | null = strip.parentElement;
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return;
    const clip = scroller;
    const size = () => { strip.style.maxHeight = `${clip.clientHeight}px`; };
    size();
    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(size);
      observer.observe(clip);
    } catch {
      window.addEventListener('resize', size);
    }
    return () => {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', size);
    };
  }, [pageLayout, numPages, pageShape]);

  useEffect(() => {
    // `nearest` so following the reader never yanks the strip around; it
    // scrolls only when the current rectangle would otherwise leave view.
    scrollElementIntoView(currentTickRef.current, { block: 'nearest', inline: 'nearest' });

    // Move focus with the current page, but ONLY when the strip already owns
    // focus. Otherwise a clicked rectangle keeps focus while the current-page
    // marker moves on, and the focus ring — which appears as soon as the
    // reader touches an arrow key and the browser switches to keyboard
    // modality — sits on a page that is no longer current: two rectangles
    // claiming to be "here". Guarding on ownership means scrolling with the
    // mouse never snatches focus from whatever the reader was doing.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && stripRef.current?.contains(active) && active !== currentTickRef.current) {
      currentTickRef.current?.focus();
    }
  }, [currentPage]);


  const pageProps = {
    scale,
    resourceUri,
    existingAnnotations,
    drawingMode: annotateDeferred ? null : drawingMode,
    selectedMotivation,
    session,
    hoveredAnnotationId,
    selectedAnnotationId,
    hoverDelayMs,
    fetchResourceAnchored,
    anchoredEpoch,
  };

  if (errorKey) {
    return <div className="semiont-pdf-annotation-canvas__error">{t(errorKey)}</div>;
  }

  return (
    <div className="semiont-pdf-annotation-canvas" data-annotate-deferred={annotateDeferred ? 'true' : 'false'}>
      {isLoading && <div className="semiont-pdf-annotation-canvas__loading">{t('loading')}</div>}
      {annotateDeferred && (
        <div className="semiont-pdf-annotation-canvas__map-pending" role="status">
          {t('preparingTextLayer')}
        </div>
      )}

      {pdfDoc && pageLayout === 'scroll' ? (
        <div className="semiont-pdf-annotation-canvas__viewport" data-axis={SCROLL_AXIS}>
        {numPages > 0 && pageShape && (
          <div
            className="semiont-pdf-annotation-canvas__strip"
            data-axis={SCROLL_AXIS}
            data-scroller="true"
            aria-orientation={SCROLL_AXIS}
            ref={stripRef}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
              <button
                key={page}
                type="button"
                data-page={page}
                className="semiont-pdf-annotation-canvas__strip-page"
                style={{ height: `${Math.round(STRIP_PAGE_WIDTH * pageShape.aspect)}px` }}
                aria-label={t('pageOf', { page, total: numPages })}
                tabIndex={page === currentPage ? 0 : -1}
                {...(page === currentPage ? { 'aria-current': 'page' as const } : {})}
                ref={page === currentPage ? currentTickRef : undefined}
                onClick={() => scrollToPage(page)}
              >
                {page}
              </button>
            ))}
          </div>
        )}
        <div className="semiont-pdf-annotation-canvas__column" data-axis={SCROLL_AXIS} ref={columnRef}>
          {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
            <div
              key={page}
              ref={registerSlot(page)}
              data-page={page}
              className="semiont-pdf-annotation-canvas__slot"
              // min-height, and applied whether or not the page is mounted:
              // releasing it on mount is what made the scrollbar jump. `min`
              // rather than a fixed height so a page that renders slightly
              // taller expands instead of clipping.
              style={slotHeight ? { minHeight: slotHeight } : undefined}
            >
              {visiblePages.has(page) && (
                <PdfPageView doc={pdfDoc} pageNumber={page} {...pageProps} />
              )}
            </div>
          ))}
        </div>
        </div>
      ) : (
        pdfDoc && !isLoading && (
          // `key` is load-bearing: without it React reuses this instance
          // across page changes, so the previous page's raster, text map and
          // load error survive into the next page — a stale overlay, a quote
          // taken from the wrong page, and an error that never clears. Each
          // page is a different thing; mounting it as one resets all of it.
          <PdfPageView key={pageNumber} doc={pdfDoc} pageNumber={pageNumber} {...pageProps} />
        )
      )}

      {/* Page navigation controls */}
      {numPages > 0 && (
        <nav className="semiont-pdf-annotation-canvas__controls" aria-label={t('pagination')}>
          <button
            disabled={currentPage <= 1}
            onClick={() => (pageLayout === 'scroll' ? scrollToPage(currentPage - 1) : setPageNumber(pageNumber - 1))}
            className="semiont-pdf-annotation-canvas__button"
          >
            {t('previous')}
          </button>
          {/*
            aria-live: the page number is the only feedback a page change gives,
            and in the scrolling column it changes without any control being
            activated at all — so a screen-reader user who scrolls would
            otherwise get silence.
          */}
          <span className="semiont-pdf-annotation-canvas__page-info" aria-live="polite">
            {t('pageOf', { page: currentPage, total: numPages })}
          </span>
          <button
            disabled={currentPage >= numPages}
            onClick={() => (pageLayout === 'scroll' ? scrollToPage(currentPage + 1) : setPageNumber(pageNumber + 1))}
            className="semiont-pdf-annotation-canvas__button"
          >
            {t('next')}
          </button>
        </nav>
      )}
    </div>
  );
}
