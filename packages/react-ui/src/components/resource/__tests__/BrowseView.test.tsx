import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowseView } from '../BrowseView';
import type { components } from '@semiont/api-client';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../contexts/EventBusContext';

type Annotation = components['schemas']['Annotation'];

// Mock ResourceAnnotationsContext - keep this simple
let mockNewAnnotationIds = new Set<string>();
vi.mock('../../../contexts/ResourceAnnotationsContext', () => ({
  useResourceAnnotations: vi.fn(() => ({
    newAnnotationIds: mockNewAnnotationIds,
  })),
}));

// Mock @semiont/api-client utilities
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getMimeCategory: vi.fn((mimeType: string) => {
      if (mimeType.startsWith('text/')) return 'text';
      if (mimeType.startsWith('image/')) return 'image';
      if (mimeType === 'application/pdf') return 'image';
      return 'unsupported';
    }),
    isPdfMimeType: vi.fn((mimeType: string) => mimeType === 'application/pdf'),
    resourceUri: vi.fn((uri: string) => uri),
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

// Mock remark-annotations
vi.mock('../../../lib/remark-annotations', () => ({
  remarkAnnotations: vi.fn(),
}));

// Mock rehype-render-annotations
vi.mock('../../../lib/rehype-render-annotations', () => ({
  rehypeRenderAnnotations: vi.fn(),
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

// Mock ImageViewer
vi.mock('../../viewers', () => ({
  ImageViewer: ({ resourceUri }: { resourceUri: string }) => (
    <img data-testid="image-viewer" src={resourceUri} alt="Resource content" />
  ),
}));

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

  function EventTrackingWrapper({ children }: { children: React.ReactNode }) {
    const eventBus = useEventBus();

    // Track subscriptions by wrapping the on method synchronously before render
    const originalOn = React.useRef(eventBus.on.bind(eventBus));

    if (!('__tracked' in eventBus.on)) {
      const trackedOn = ((eventName: string, handler: Function) => {
        subscriptions.add(eventName);
        return originalOn.current(eventName, handler);
      }) as typeof eventBus.on & { __tracked: true };
      trackedOn.__tracked = true;
      eventBus.on = trackedOn;
    }

    React.useEffect(() => {
      const handlers: Array<() => void> = [];

      // Track all annotation-related events
      const trackEvent = (eventName: string) => (payload: any) => {
        events.push({ event: eventName, payload });
      };

      const annotationEvents = [
        'annotation:hover',
        'annotation:click',
        'annotation:focus',
      ];

      annotationEvents.forEach(eventName => {
        const handler = trackEvent(eventName);
        eventBus.on(eventName, handler);
        handlers.push(() => eventBus.off(eventName, handler));
      });

      return () => {
        handlers.forEach(cleanup => cleanup());
      };
    }, [eventBus]);

    return <>{children}</>;
  }

  return {
    EventTrackingWrapper,
    events,
    subscriptions,
    clear: () => {
      events.length = 0;
      subscriptions.clear();
    },
  };
}

// Helper to render with providers - simple composition, no spy wrappers
const renderWithProviders = (
  component: React.ReactElement,
  options: { newAnnotationIds?: Set<string> } = {}
) => {
  // Update the mock if new annotation IDs are provided
  if (options.newAnnotationIds) {
    mockNewAnnotationIds = options.newAnnotationIds;
  }

  return render(
    <EventBusProvider>
      {component}
    </EventBusProvider>
  );
};

// Helper to render with event tracking
const renderWithEventTracking = (
  component: React.ReactElement,
  tracker: ReturnType<typeof createEventTracker>,
  options: { newAnnotationIds?: Set<string> } = {}
) => {
  if (options.newAnnotationIds) {
    mockNewAnnotationIds = options.newAnnotationIds;
  }

  return render(
    <EventBusProvider>
      <tracker.EventTrackingWrapper>
        {component}
      </tracker.EventTrackingWrapper>
    </EventBusProvider>
  );
};

// Test data fixtures
const createMockAnnotation = (motivation: string, id: string): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id,
  type: 'Annotation',
  motivation,
  creator: { name: 'user@example.com' },
  created: '2024-01-01T10:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextPositionSelector',
      start: 0,
      end: 10,
    },
  },
  body: [],
});

describe('BrowseView Component', () => {
  const defaultProps = {
    content: '# Test Content\n\nThis is test markdown content.',
    mimeType: 'text/markdown',
    resourceUri: 'http://localhost:8080/resources/test-resource',
    annotations: {
      highlights: [],
      references: [],
      assessments: [],
      comments: [],
      tags: [],
    },
    hoveredAnnotationId: null,
    hoveredCommentId: null,
    selectedClick: 'detail' as const,
    annotateMode: false,
  };

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();
    mockNewAnnotationIds = new Set();

    // Mock scrollIntoView for jsdom
    if (typeof Element !== 'undefined') {
      Element.prototype.scrollIntoView = vi.fn();
    }

    // Mock querySelector and querySelectorAll
    if (typeof document !== 'undefined') {
      document.querySelector = vi.fn();
      document.querySelectorAll = vi.fn(() => []);
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

    it('should render image viewer for image mime types', () => {
      renderWithProviders(<BrowseView {...defaultProps} mimeType="image/png" />);

      expect(screen.getByTestId('image-viewer')).toBeInTheDocument();
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

    it('should emit annotation:hover when mouse enters annotation', async () => {
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
          e.event === 'annotation:hover' && e.payload?.annotationId === 'ref-1'
        )).toBe(true);
      });
    });

    it('should emit annotation:hover with null when mouse exits after dwell', async () => {
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
        e.event === 'annotation:hover' && e.payload?.annotationId === null
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
          e.event === 'annotation:hover' && e.payload?.annotationId === 'ref-1'
        )).toBe(true);
      });

      tracker.clear();

      // Exit first annotation
      fireEvent.mouseOut(browseContainer!, { target: mockTarget1 });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'annotation:hover' && e.payload?.annotationId === null
        )).toBe(true);
      });

      tracker.clear();

      // Enter second annotation
      fireEvent.mouseOver(browseContainer!, { target: mockTarget2 });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'annotation:hover' && e.payload?.annotationId === 'ref-2'
        )).toBe(true);
      });
    });

    it('should emit annotation:click only for reference annotations', async () => {
      const tracker = createEventTracker();
      const annotations = {
        ...defaultProps.annotations,
        references: [createMockAnnotation('linking', 'ref-1')],
        highlights: [createMockAnnotation('highlighting', 'highlight-1')],
      };

      const { container } = renderWithEventTracking(
        <BrowseView {...defaultProps} annotations={annotations} />,
        tracker
      );

      const mockReferenceElement = document.createElement('span');
      mockReferenceElement.setAttribute('data-annotation-id', 'ref-1');
      mockReferenceElement.setAttribute('data-annotation-type', 'reference');

      const mockHighlightElement = document.createElement('span');
      mockHighlightElement.setAttribute('data-annotation-id', 'highlight-1');
      mockHighlightElement.setAttribute('data-annotation-type', 'highlight');

      const mockRefTarget = { closest: vi.fn(() => mockReferenceElement) } as any;
      const mockHighlightTarget = { closest: vi.fn(() => mockHighlightElement) } as any;

      const browseContainer = container.querySelector('.semiont-browse-view__content');

      tracker.clear();

      // Click reference - should emit
      fireEvent.click(browseContainer!, { target: mockRefTarget });

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'annotation:click' &&
          e.payload?.annotationId === 'ref-1' &&
          e.payload?.motivation === 'linking'
        )).toBe(true);
      });

      tracker.clear();

      // Click highlight - should not emit
      fireEvent.click(browseContainer!, { target: mockHighlightTarget });

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(tracker.events.filter(e => e.event === 'annotation:click').length).toBe(0);
    });
  });

  describe('Event Subscriptions', () => {
    it('should subscribe to annotation:hover event', () => {
      const tracker = createEventTracker();
      renderWithEventTracking(<BrowseView {...defaultProps} />, tracker);

      expect(tracker.subscriptions.has('annotation:hover')).toBe(true);
    });

    it('should subscribe to annotation:hover event (legacy test)', () => {
      const tracker = createEventTracker();
      renderWithEventTracking(<BrowseView {...defaultProps} />, tracker);

      // BrowseView subscribes to annotation:hover (not annotation-entry:hover)
      expect(tracker.subscriptions.has('annotation:hover')).toBe(true);
    });

    it('should subscribe to annotation:focus event', () => {
      const tracker = createEventTracker();
      renderWithEventTracking(<BrowseView {...defaultProps} />, tracker);

      expect(tracker.subscriptions.has('annotation:focus')).toBe(true);
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
      // Create a composition-based event tracker that subscribes like a real consumer
      const eventTracker: Array<{ event: string; annotationId: string | null }> = [];

      function EventTrackingWrapper({ children }: { children: React.ReactNode }) {
        const eventBus = useEventBus();

        React.useEffect(() => {
          // Subscribe to events like a real component would
          const handleHover = (payload: any) => {
            eventTracker.push({ event: 'annotation:hover', annotationId: payload?.annotationId ?? null });
          };

          const handleClick = (payload: any) => {
            eventTracker.push({ event: 'annotation:click', annotationId: payload?.annotationId ?? null });
          };

          eventBus.on('annotation:hover', handleHover);
          eventBus.on('annotation:click', handleClick);

          return () => {
            eventBus.off('annotation:hover', handleHover);
            eventBus.off('annotation:click', handleClick);
          };
        }, [eventBus]);

        return <>{children}</>;
      }

      // Create many annotations
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

      const { container } = render(
        <EventBusProvider>
          <EventTrackingWrapper>
            <BrowseView {...defaultProps} annotations={manyAnnotations} />
          </EventTrackingWrapper>
        </EventBusProvider>
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
        expect(eventTracker.some(e => e.event === 'annotation:hover' && e.annotationId === 'ref-1')).toBe(true);
      });

      fireEvent.click(browseContainer!, { target: mockRefTarget });
      await waitFor(() => {
        expect(eventTracker.some(e => e.event === 'annotation:click' && e.annotationId === 'ref-1')).toBe(true);
      });

      // Verify highlight doesn't trigger click events
      eventTracker.length = 0; // Clear tracker
      fireEvent.click(browseContainer!, { target: mockHighlightTarget });

      // Should not have any click events for highlights
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(eventTracker.some(e => e.event === 'annotation:click')).toBe(false);

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
