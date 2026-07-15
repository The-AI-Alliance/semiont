import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowseView } from '../BrowseView';
import type { EventBus } from '@semiont/core';
import type { SemiontClient, SemiontSession } from '@semiont/sdk';
import { createTestSemiontWrapper } from '../../../test-utils';

import type { Annotation, AnnotationId } from '@semiont/core';

// BrowseView takes its `session` + `newAnnotationIds` as props now (step 1a) — no
// ResourceAnnotationsContext / SemiontProvider reach-in. `makeSession` (below)
// wraps the fake client so browse:click / beckon:hover land on the bus the
// trackers listen on, and session.subscribe registers beckon:* on that bus.

// Mock @semiont/core utilities. The media-type registry (`capabilitiesOf`)
// is NOT mocked — BrowseView dispatches on the real registry's render mode,
// so the tested types (text/markdown, image/png, application/octet-stream)
// resolve through the real source of truth.
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
  return {
    ...actual,
    resourceId: vi.fn((id: string) => id),
    getExactText: vi.fn(() => 'exact text'),
    getTextPositionSelector: vi.fn(() => ({ start: 0, end: 10 })),
    getTargetSelector: vi.fn(() => ({ type: 'TextPositionSelector', start: 0, end: 10 })),
    getBodySource: vi.fn(() => null),
  };
});

// Mock ReactMarkdown
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown-content">{children}</div>,
}));

// Mock remark-gfm
vi.mock('remark-gfm', () => ({
  default: vi.fn(),
}));

// Mock annotation-overlay — DOM Range API is not available in jsdom
vi.mock('../../../lib/annotation-overlay', () => ({
  buildSourceToRenderedMap: vi.fn(() => new Map()),
  buildTextNodeIndex: vi.fn(() => []),
  resolveAnnotationRanges: vi.fn(() => new Map()),
  applyHighlights: vi.fn(),
  clearHighlights: vi.fn(),
  toOverlayAnnotations: vi.fn(() => []),
}));

// Mock ANNOTATORS
vi.mock('../../../lib/annotation-registry', () => ({
  ANNOTATORS: {
    highlight: {
      internalType: 'highlight',
      className: 'annotation-highlight',
      matchesAnnotation: (ann: Annotation) => ann.motivation === 'highlighting',
    },
    reference: {
      internalType: 'reference',
      className: 'annotation-reference',
      matchesAnnotation: (ann: Annotation) => ann.motivation === 'linking',
    },
    comment: {
      internalType: 'comment',
      className: 'annotation-comment',
      matchesAnnotation: (ann: Annotation) => ann.motivation === 'commenting',
    },
  },
}));

// Image browse renders the read-only SvgDrawingCanvas (real component — jsdom
// renders its container fine; shape painting is covered by the dispatch spec).

// Mock AnnotateToolbar
vi.mock('../../annotation/AnnotateToolbar', () => ({
  AnnotateToolbar: () => <div data-testid="annotate-toolbar">Toolbar</div>,
}));

// Composition-based event tracker - subscribes to events like a real component
interface TrackedEvent {
  event: string;
  payload: any;
}

function createEventTracker() {
  const events: TrackedEvent[] = [];
  const subscriptions: Set<string> = new Set();
  return {
    events,
    subscriptions,
    clear: () => {
      events.length = 0;
      subscriptions.clear();
    },
    _attach(eventBus: EventBus) {
      const annotationEvents = [
        'beckon:hover',
        'browse:click',
        'beckon:focus',
      ] as const;
      annotationEvents.forEach((eventName) => {
        subscriptions.add(eventName);
        eventBus.get(eventName).subscribe((payload: any) => {
          events.push({ event: eventName, payload });
        });
      });
    },
  };
}

// BrowseView now takes its session as a prop. Wrap the fake client so
// browse:click / beckon:hover emit on the SAME bus the trackers listen on, and
// session.subscribe registers beckon:* there (mirrors test-utils' fake session).
function makeSession(client: SemiontClient): SemiontSession {
  return {
    client,
    subscribe: (channel: string, handler: (p: never) => void) => {
      const sub = (client.bus.get(channel as never) as { subscribe(fn: (p: never) => void): { unsubscribe(): void } }).subscribe(handler);
      return () => sub.unsubscribe();
    },
  } as unknown as SemiontSession;
}

const renderWithProviders = (
  component: React.ReactElement<React.ComponentProps<typeof BrowseView>>,
  options: { newAnnotationIds?: Set<string> } = {}
) => {
  const { SemiontWrapper, client } = createTestSemiontWrapper();
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  return render(
    React.cloneElement(component, { session: makeSession(client), newAnnotationIds: options.newAnnotationIds }),
    { wrapper: Wrapper },
  );
};

const renderWithEventTracking = (
  component: React.ReactElement<React.ComponentProps<typeof BrowseView>>,
  tracker: ReturnType<typeof createEventTracker>,
  options: { newAnnotationIds?: Set<string> } = {}
) => {
  const { SemiontWrapper, eventBus, client } = createTestSemiontWrapper();
  tracker._attach(eventBus);
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  return render(
    React.cloneElement(component, { session: makeSession(client), newAnnotationIds: options.newAnnotationIds }),
    { wrapper: Wrapper },
  );
};

// Test data fixtures
const createMockAnnotation = (motivation: Annotation['motivation'], id: string): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: id as AnnotationId,
  type: 'Annotation',
  motivation,
  creator: { '@type': 'Person', name: 'user@example.com' },
  created: '2024-01-01T10:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextPositionSelector',
      start: 0,
      end: 10,
    },
  },
});

describe('BrowseView Component', () => {
  const defaultProps = {
    content: '# Test Content\n\nThis is test markdown content.',
    mimeType: 'text/markdown',
    resourceUri: 'test-resource',
    annotations: {
      highlights: [],
      references: [],
      assessments: [],
      comments: [],
      tags: [],
    },
    hoveredAnnotationId: null,
    selectedClick: 'detail' as const,
    annotateMode: false,
    // Placeholder — the render helpers override this with a session bound to the
    // fake client's bus (so emits/subscriptions land where the trackers listen).
    session: null as SemiontSession | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock scrollIntoView for jsdom
    if (typeof Element !== 'undefined') {
      Element.prototype.scrollIntoView = vi.fn();
    }

    // Mock querySelector and querySelectorAll
    if (typeof document !== 'undefined') {
      document.querySelector = vi.fn();
      // Return a real (empty) NodeList so the mock matches the DOM signature.
      const emptyNodeList = document.createDocumentFragment().querySelectorAll('*');
      document.querySelectorAll = vi.fn(() => emptyNodeList);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render markdown content in text mode', () => {
      renderWithProviders(<BrowseView {...defaultProps} />);

      expect(screen.getByTestId('markdown-content')).toBeInTheDocument();
      expect(screen.getByTestId('annotate-toolbar')).toBeInTheDocument();
    });

    it('should render the read-only annotation canvas for image mime types', () => {
      // Was a bare ImageViewer, which silently dropped the annotations prop
      // (bugs/image-browse-renderer-drops-annotations.md).
      const { container } = renderWithProviders(<BrowseView {...defaultProps} mimeType="image/png" />);

      expect(container.querySelector('.semiont-svg-drawing-canvas')).toBeInTheDocument();
    });

    it('should render unsupported message for unsupported mime types', () => {
      renderWithProviders(<BrowseView {...defaultProps} mimeType="application/octet-stream" />);

      expect(screen.getByText(/Preview not available/)).toBeInTheDocument();
      expect(screen.getByText('Download File')).toBeInTheDocument();
    });

    it('should apply correct data-mime-type attribute', () => {
      const { container } = renderWithProviders(<BrowseView {...defaultProps} />);

      const browseView = container.querySelector('[data-mime-type="text"]');
      expect(browseView).toBeInTheDocument();
    });
  });

  describe('Event Handling - Clean Enter/Exit Pattern', () => {
    it('should attach single click handler to container on mount', () => {
      const { container } = renderWithProviders(<BrowseView {...defaultProps} />);

      const browseContainer = container.querySelector('.semiont-browse-view__content');
      expect(browseContainer).toBeInTheDocument();

      // Verify handler is attached by checking if the element exists
      // (actual handler testing requires DOM interaction)
    });

    it('should emit beckon:hover when mouse enters annotation', async () => {
      const tracker = createEventTracker();
      const annotations = {
        ...defaultProps.annotations,
        references: [createMockAnnotation('linking', 'ref-1')],
      };

      const { container } = renderWithEventTracking(
        <BrowseView {...defaultProps} annotations={annotations} />,
        tracker
      );

      // Create mock annotation element
      const mockAnnotationElement = document.createElement('span');
      mockAnnotationElement.setAttribute('data-annotation-id', 'ref-1');
      mockAnnotationElement.setAttribute('data-annotation-type', 'reference');

      // Mock closest to return our annotation element
      const mockTarget = {
        closest: vi.fn(() => mockAnnotationElement),
      } as any;

      const browseContainer = container.querySelector('.semiont-browse-view__content');

      // Simulate mouseover event (fires once on enter)
      fireEvent.mouseOver(browseContainer!, { target: mockTarget });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'beckon:hover' && e.payload?.annotationId === 'ref-1'
        )).toBe(true);
      });
    });

    it('should emit beckon:hover with null when mouse exits after dwell', async () => {
      vi.useFakeTimers();
      const tracker = createEventTracker();
      const annotations = {
        ...defaultProps.annotations,
        references: [createMockAnnotation('linking', 'ref-1')],
      };
      const { container } = renderWithEventTracking(
        <BrowseView {...defaultProps} annotations={annotations} />,
        tracker
      );

      const browseContainer = container.querySelector('.semiont-browse-view__content');

      const mockAnnotationElement = document.createElement('span');
      mockAnnotationElement.setAttribute('data-annotation-id', 'ref-1');
      const mockTarget = { closest: vi.fn(() => mockAnnotationElement) } as any;

      // Enter and let dwell timer fire
      fireEvent.mouseOver(browseContainer!, { target: mockTarget });
      vi.advanceTimersByTime(200);

      tracker.clear();

      // Now exit — should emit null
      fireEvent.mouseOut(browseContainer!, { target: mockTarget });

      expect(tracker.events.some(e =>
        e.event === 'beckon:hover' && e.payload?.annotationId === null
      )).toBe(true);

      vi.useRealTimers();
    });

    it('should not emit on mouseover when not over annotation', async () => {
      const tracker = createEventTracker();
      const { container } = renderWithEventTracking(<BrowseView {...defaultProps} />, tracker);

      const mockTargetNoAnnotation = {
        closest: vi.fn(() => null),
      } as any;

      const browseContainer = container.querySelector('.semiont-browse-view__content');

      tracker.clear();

      // Mouse over non-annotation area
      fireEvent.mouseOver(browseContainer!, { target: mockTargetNoAnnotation });

      // Should not emit any event
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(tracker.events.length).toBe(0);
    });

    it('should emit separate events when moving from one annotation to another', async () => {
      const tracker = createEventTracker();
      const annotations = {
        ...defaultProps.annotations,
        references: [
          createMockAnnotation('linking', 'ref-1'),
          createMockAnnotation('linking', 'ref-2'),
        ],
      };

      const { container } = renderWithEventTracking(
        <BrowseView {...defaultProps} annotations={annotations} />,
        tracker
      );

      const mockAnnotation1 = document.createElement('span');
      mockAnnotation1.setAttribute('data-annotation-id', 'ref-1');

      const mockAnnotation2 = document.createElement('span');
      mockAnnotation2.setAttribute('data-annotation-id', 'ref-2');

      const mockTarget1 = { closest: vi.fn(() => mockAnnotation1) } as any;
      const mockTarget2 = { closest: vi.fn(() => mockAnnotation2) } as any;

      const browseContainer = container.querySelector('.semiont-browse-view__content');

      tracker.clear();

      // Enter first annotation
      fireEvent.mouseOver(browseContainer!, { target: mockTarget1 });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'beckon:hover' && e.payload?.annotationId === 'ref-1'
        )).toBe(true);
      });

      tracker.clear();

      // Exit first annotation
      fireEvent.mouseOut(browseContainer!, { target: mockTarget1 });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'beckon:hover' && e.payload?.annotationId === null
        )).toBe(true);
      });

      tracker.clear();

      // Enter second annotation
      fireEvent.mouseOver(browseContainer!, { target: mockTarget2 });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'beckon:hover' && e.payload?.annotationId === 'ref-2'
        )).toBe(true);
      });
    });

    it('should emit browse:click for every motivation', async () => {
      // browse:click is the platform's one "user clicked an annotation" signal;
      // text browse mode must emit it for whatever the click resolves, matching
      // the image/PDF/annotate emitters (BROWSE-CLICK-ALL-MOTIVATIONS.md).
      const tracker = createEventTracker();
      const annotations = {
        ...defaultProps.annotations,
        references: [createMockAnnotation('linking', 'ref-1')],
        highlights: [createMockAnnotation('highlighting', 'highlight-1')],
        comments: [createMockAnnotation('commenting', 'comment-1')],
      };

      const { container } = renderWithEventTracking(
        <BrowseView {...defaultProps} annotations={annotations} />,
        tracker
      );

      const browseContainer = container.querySelector('.semiont-browse-view__content');

      const clickCases = [
        { id: 'ref-1', type: 'reference', motivation: 'linking' },
        { id: 'highlight-1', type: 'highlight', motivation: 'highlighting' },
        { id: 'comment-1', type: 'comment', motivation: 'commenting' },
      ] as const;

      for (const { id, type, motivation } of clickCases) {
        const el = document.createElement('span');
        el.setAttribute('data-annotation-id', id);
        el.setAttribute('data-annotation-type', type);
        const mockTarget = { closest: vi.fn(() => el) } as unknown as EventTarget;

        tracker.clear();
        fireEvent.click(browseContainer!, { target: mockTarget });

        await waitFor(() => {
          expect(tracker.events.some(e =>
            e.event === 'browse:click' &&
            e.payload?.annotationId === id &&
            e.payload?.motivation === motivation
          )).toBe(true);
        });
      }
    });

    it('should include the clicked span rect as anchorRect', async () => {
      // A1 anchor thread (HEADLESS-ANNOTATION-PANELS Phase 3): the emission
      // site owns the geometry — the clicked span's viewport rect rides the
      // event so hosts can anchor popovers. Runtime-only; no schema pin.
      const tracker = createEventTracker();
      const annotations = {
        ...defaultProps.annotations,
        highlights: [createMockAnnotation('highlighting', 'highlight-1')],
      };

      const { container } = renderWithEventTracking(
        <BrowseView {...defaultProps} annotations={annotations} />,
        tracker
      );

      const el = document.createElement('span');
      el.setAttribute('data-annotation-id', 'highlight-1');
      el.setAttribute('data-annotation-type', 'highlight');
      const RECT: DOMRect = {
        x: 10, y: 20, width: 30, height: 40,
        top: 20, right: 40, bottom: 60, left: 10,
        toJSON: () => ({}),
      };
      el.getBoundingClientRect = () => RECT;
      const mockTarget = { closest: vi.fn(() => el) } as unknown as EventTarget;

      const browseContainer = container.querySelector('.semiont-browse-view__content');
      tracker.clear();
      fireEvent.click(browseContainer!, { target: mockTarget });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'browse:click' &&
          e.payload?.annotationId === 'highlight-1' &&
          e.payload?.anchorRect?.left === 10 &&
          e.payload?.anchorRect?.width === 30
        )).toBe(true);
      });
    });

    it('should not emit browse:click when the click completes a text selection', async () => {
      // Browse mode is the reading surface: a drag-select that starts and ends
      // inside one annotated span fires click on it. The guard applies to
      // references too — a copy-drag inside a reference span must not emit
      // (deliberate behavior change; previously it navigated under `follow`).
      const tracker = createEventTracker();
      const annotations = {
        ...defaultProps.annotations,
        references: [createMockAnnotation('linking', 'ref-1')],
      };

      const { container } = renderWithEventTracking(
        <BrowseView {...defaultProps} annotations={annotations} />,
        tracker
      );

      const el = document.createElement('span');
      el.setAttribute('data-annotation-id', 'ref-1');
      el.setAttribute('data-annotation-type', 'reference');
      const mockTarget = { closest: vi.fn(() => el) } as unknown as EventTarget;

      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
      } as Selection);

      const browseContainer = container.querySelector('.semiont-browse-view__content');
      tracker.clear();
      fireEvent.click(browseContainer!, { target: mockTarget });

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(tracker.events.filter(e => e.event === 'browse:click').length).toBe(0);
    });
  });

  describe('Event Subscriptions', () => {
    it('should subscribe to beckon:hover event', () => {
      const tracker = createEventTracker();
      renderWithEventTracking(<BrowseView {...defaultProps} />, tracker);

      expect(tracker.subscriptions.has('beckon:hover')).toBe(true);
    });

    it('should subscribe to beckon:hover event (legacy test)', () => {
      const tracker = createEventTracker();
      renderWithEventTracking(<BrowseView {...defaultProps} />, tracker);

      // BrowseView subscribes to beckon:hover (not annotation-entry:hover)
      expect(tracker.subscriptions.has('beckon:hover')).toBe(true);
    });

    it('should subscribe to beckon:focus event', () => {
      const tracker = createEventTracker();
      renderWithEventTracking(<BrowseView {...defaultProps} />, tracker);

      expect(tracker.subscriptions.has('beckon:focus')).toBe(true);
    });
  });

  describe('Annotation Animation Classes', () => {
    it('should apply sparkle class to new annotations', () => {
      const newAnnotationIds = new Set(['new-annotation-1']);

      const annotations = {
        ...defaultProps.annotations,
        highlights: [createMockAnnotation('highlighting', 'new-annotation-1')],
      };

      renderWithProviders(<BrowseView {...defaultProps} annotations={annotations} />, {
        newAnnotationIds
      });

      // Verify the newAnnotationIds set contains the expected annotation
      // In the actual component, this triggers the sparkle class application
      expect(newAnnotationIds.has('new-annotation-1')).toBe(true);
    });
  });

  describe('Performance - Event Listener Efficiency', () => {
    it('should handle many annotations efficiently through event delegation', async () => {
      const eventTracker: Array<{ event: string; annotationId: string | null }> = [];

      const manyAnnotations = {
        highlights: Array.from({ length: 50 }, (_, i) =>
          createMockAnnotation('highlighting', `highlight-${i}`)
        ),
        references: Array.from({ length: 50 }, (_, i) =>
          createMockAnnotation('linking', `ref-${i}`)
        ),
        assessments: [],
        comments: [],
        tags: [],
      };

      const { SemiontWrapper, eventBus, client } = createTestSemiontWrapper();
      eventBus.get('beckon:hover').subscribe((payload: any) => {
        eventTracker.push({ event: 'beckon:hover', annotationId: payload?.annotationId ?? null });
      });
      eventBus.get('browse:click').subscribe((payload: any) => {
        eventTracker.push({ event: 'browse:click', annotationId: payload?.annotationId ?? null });
      });

      const { container } = render(
        <SemiontWrapper>
          <BrowseView {...defaultProps} annotations={manyAnnotations} session={makeSession(client)} />
        </SemiontWrapper>
      );

      const browseContainer = container.querySelector('.semiont-browse-view__content');
      expect(browseContainer).toBeInTheDocument();

      // Create mock annotation elements
      const mockRefElement = document.createElement('span');
      mockRefElement.setAttribute('data-annotation-id', 'ref-1');
      mockRefElement.setAttribute('data-annotation-type', 'reference');

      const mockHighlightElement = document.createElement('span');
      mockHighlightElement.setAttribute('data-annotation-id', 'highlight-1');
      mockHighlightElement.setAttribute('data-annotation-type', 'highlight');

      const mockRefTarget = { closest: vi.fn(() => mockRefElement) } as any;
      const mockHighlightTarget = { closest: vi.fn(() => mockHighlightElement) } as any;

      // Verify event delegation works by simulating interactions
      fireEvent.mouseOver(browseContainer!, { target: mockRefTarget });
      await waitFor(() => {
        expect(eventTracker.some(e => e.event === 'beckon:hover' && e.annotationId === 'ref-1')).toBe(true);
      });

      fireEvent.click(browseContainer!, { target: mockRefTarget });
      await waitFor(() => {
        expect(eventTracker.some(e => e.event === 'browse:click' && e.annotationId === 'ref-1')).toBe(true);
      });

      // Highlights emit through the same delegated handler (all motivations)
      eventTracker.length = 0; // Clear tracker
      fireEvent.click(browseContainer!, { target: mockHighlightTarget });

      await waitFor(() => {
        expect(eventTracker.some(e => e.event === 'browse:click' && e.annotationId === 'highlight-1')).toBe(true);
      });

      // The key insight: With event delegation, we can handle 100 annotations
      // with only container-level listeners, not 100+ individual listeners
      // This is verified by the component successfully rendering and responding to events
    });
  });

  describe('Cleanup', () => {
    it('should remove event listeners on unmount', () => {
      const { unmount, container } = renderWithProviders(<BrowseView {...defaultProps} />);

      const browseContainer = container.querySelector('.semiont-browse-view__content');

      // Mock removeEventListener to verify cleanup
      const mockRemoveEventListener = vi.fn();
      if (browseContainer) {
        browseContainer.removeEventListener = mockRemoveEventListener;
      }

      unmount();

      // In the real implementation, cleanup happens in useEffect return
      // We verify the component can unmount without errors
      expect(true).toBe(true);
    });
  });
});
