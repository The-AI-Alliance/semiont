import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAnnotationPanel } from '../useAnnotationPanel';
import type { components } from '@semiont/api-client';
import { EventBusProvider, useEventBus, resetEventBusForTesting } from '../../contexts/EventBusContext';
import type { EventBus } from '../../contexts/EventBusContext';

type Annotation = components['schemas']['Annotation'];

// Mock annotations with text position selectors
const createMockAnnotation = (id: string, start: number): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: `http://localhost:8080/annotations/${id}`,
  type: 'Annotation',
  creator: 'user-123',
  created: new Date().toISOString(),
  motivation: 'commenting',
  body: [],
  target: {
    source: 'http://localhost:8080/resources/doc-123',
    selector: [
      {
        type: 'TextPositionSelector',
        start,
        end: start + 10,
      },
      {
        type: 'TextQuoteSelector',
        exact: 'test text',
      },
    ],
  },
});

describe('useAnnotationPanel', () => {
  let mockContainerRef: React.RefObject<HTMLDivElement>;
  let mockElement: HTMLElement;

  beforeEach(() => {
    // Reset global event bus for test isolation
    resetEventBusForTesting();
    // Create mock container
    const container = document.createElement('div');
    container.getBoundingClientRect = vi.fn(() => ({
      top: 0,
      bottom: 500,
      left: 0,
      right: 500,
      width: 500,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));
    Object.defineProperty(container, 'clientHeight', {
      value: 500,
      writable: false,
      configurable: true,
    });
    container.scrollTo = vi.fn();

    mockContainerRef = { current: container };

    // Create mock annotation element
    mockElement = document.createElement('div');
    Object.defineProperty(mockElement, 'offsetTop', {
      value: 200,
      writable: false,
      configurable: true,
    });
    Object.defineProperty(mockElement, 'offsetHeight', {
      value: 50,
      writable: false,
      configurable: true,
    });
    mockElement.getBoundingClientRect = vi.fn(() => ({
      top: 200,
      bottom: 250,
      left: 0,
      right: 500,
      width: 500,
      height: 50,
      x: 0,
      y: 200,
      toJSON: () => ({}),
    }));
    mockElement.classList.add = vi.fn();
    mockElement.classList.remove = vi.fn();

    // Mock timers for pulse effect
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <EventBusProvider>{children}</EventBusProvider>
  );

  // Helper to get event bus from within a test
  function setupTest(annotations: Annotation[]) {
    let eventBus: EventBus;
    const { result, rerender } = renderHook(
      () => {
        eventBus = useEventBus();
        return useAnnotationPanel(annotations, mockContainerRef);
      },
      { wrapper }
    );
    return { result, rerender, getEventBus: () => eventBus! };
  }

  describe('annotation sorting', () => {
    it('should sort annotations by start position', () => {
      const annotations = [
        createMockAnnotation('anno-3', 300),
        createMockAnnotation('anno-1', 100),
        createMockAnnotation('anno-2', 200),
      ];

      const { result } = setupTest(annotations);

      expect(result.current.sortedAnnotations).toHaveLength(3);
      expect(result.current.sortedAnnotations[0].id).toBe('http://localhost:8080/annotations/anno-1');
      expect(result.current.sortedAnnotations[1].id).toBe('http://localhost:8080/annotations/anno-2');
      expect(result.current.sortedAnnotations[2].id).toBe('http://localhost:8080/annotations/anno-3');
    });

    it('should handle empty annotations array', () => {
      const { result } = setupTest([]);

      expect(result.current.sortedAnnotations).toHaveLength(0);
    });
  });

  describe('ref management via annotation:ref-update events', () => {
    it('should register element ref when annotation:ref-update is emitted with element', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Emit ref-update event with element
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      // Now emit hover event - should find the registered element
      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      // Should attempt to scroll (proves ref was registered)
      expect(scrollToSpy).toHaveBeenCalled();
    });

    it('should clear element ref when annotation:ref-update is emitted with null', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      // Clear ref
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: null,
        });
      });

      // Now emit hover event - should NOT find element
      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      // Should warn about missing element (proves ref was cleared)
      expect(consoleWarn).toHaveBeenCalledWith(
        '[useAnnotationPanel] No element found for annotationId:',
        annotationId
      );
      expect(scrollToSpy).not.toHaveBeenCalled();

      consoleWarn.mockRestore();
    });
  });

  describe('event subscriptions', () => {
    it('should subscribe to annotation:hover event', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref first
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      // Emit hover event
      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      expect(scrollToSpy).toHaveBeenCalled();
    });

    it('should subscribe to annotation-entry:hover event', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref first
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      // Emit entry hover event
      act(() => {
        eventBus.emit('annotation-entry:hover', { annotationId });
      });

      expect(scrollToSpy).toHaveBeenCalled();
    });

    it('should subscribe to annotation:click event', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref first
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      // Emit click event
      act(() => {
        eventBus.emit('annotation:click', { annotationId });
      });

      expect(scrollToSpy).toHaveBeenCalled();
    });

    it('should ignore hover event when annotationId is null', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      // Emit hover event with null
      act(() => {
        eventBus.emit('annotation:hover', { annotationId: null });
      });

      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it('should ignore entry hover event when annotationId is null', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      // Emit entry hover event with null
      act(() => {
        eventBus.emit('annotation-entry:hover', { annotationId: null });
      });

      expect(scrollToSpy).not.toHaveBeenCalled();
    });
  });

  describe('scrollToAnnotation behavior', () => {
    it('should scroll element into view when not visible', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      // Make element not visible (outside container bounds)
      mockElement.getBoundingClientRect = vi.fn(() => ({
        top: 600, // Below container bottom (500)
        bottom: 650,
        left: 0,
        right: 500,
        width: 500,
        height: 50,
        x: 0,
        y: 600,
        toJSON: () => ({}),
      }));

      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      // Emit hover event
      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      // Should scroll to center the element
      expect(scrollToSpy).toHaveBeenCalledWith({
        top: expect.any(Number),
        behavior: 'smooth',
      });
    });

    it('should skip scroll when element is already visible', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      // Make element fully visible within container
      mockElement.getBoundingClientRect = vi.fn(() => ({
        top: 100, // Within container (0-500)
        bottom: 150,
        left: 0,
        right: 500,
        width: 500,
        height: 50,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      }));

      const scrollToSpy = vi.spyOn(mockContainerRef.current!, 'scrollTo');

      // Emit hover event
      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      // Should NOT scroll (element already visible)
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it('should add and remove pulse CSS class', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      // Emit hover event
      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      // Should add pulse class immediately
      expect(mockElement.classList.add).toHaveBeenCalledWith('semiont-annotation-pulse');

      // Advance timers to trigger removal
      act(() => {
        vi.advanceTimersByTime(1500);
      });

      // Should remove pulse class after 1500ms
      expect(mockElement.classList.remove).toHaveBeenCalledWith('semiont-annotation-pulse');
    });

    it('should warn when element not found in refs', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Don't register ref - emit hover event directly
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      expect(consoleWarn).toHaveBeenCalledWith(
        '[useAnnotationPanel] No element found for annotationId:',
        annotationId
      );

      consoleWarn.mockRestore();
    });

    it('should warn when container ref is null', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';
      const nullContainerRef = { current: null };

      let eventBus: EventBus;
      renderHook(
        () => {
          eventBus = useEventBus();
          return useAnnotationPanel(annotations, nullContainerRef);
        },
        { wrapper }
      );

      // Register ref
      act(() => {
        eventBus!.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      act(() => {
        eventBus!.emit('annotation:hover', { annotationId });
      });

      expect(consoleWarn).toHaveBeenCalledWith('[useAnnotationPanel] No container ref');

      consoleWarn.mockRestore();
    });
  });

  describe('logging for debugging', () => {
    it('should log when scrollToAnnotation is called', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      // Register ref
      act(() => {
        eventBus.emit('annotation:ref-update', {
          annotationId,
          element: mockElement,
        });
      });

      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });

      expect(consoleLog).toHaveBeenCalledWith(
        '[useAnnotationPanel] scrollToAnnotation called with:',
        annotationId
      );
      expect(consoleLog).toHaveBeenCalledWith(
        '[useAnnotationPanel] refs.current has keys:',
        expect.any(Array)
      );

      consoleLog.mockRestore();
    });

    it('should log when events are received', () => {
      const annotations = [createMockAnnotation('anno-1', 100)];
      const annotationId = 'http://localhost:8080/annotations/anno-1';

      const { getEventBus } = setupTest(annotations);
      const eventBus = getEventBus();

      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Test each event type
      act(() => {
        eventBus.emit('annotation:hover', { annotationId });
      });
      expect(consoleLog).toHaveBeenCalledWith(
        '[useAnnotationPanel] annotation:hover event received:',
        annotationId
      );

      act(() => {
        eventBus.emit('annotation-entry:hover', { annotationId });
      });
      expect(consoleLog).toHaveBeenCalledWith(
        '[useAnnotationPanel] annotation-entry:hover event received:',
        annotationId
      );

      act(() => {
        eventBus.emit('annotation:click', { annotationId });
      });
      expect(consoleLog).toHaveBeenCalledWith(
        '[useAnnotationPanel] annotation:click event received:',
        annotationId
      );

      act(() => {
        eventBus.emit('annotation:ref-update', { annotationId, element: mockElement });
      });
      expect(consoleLog).toHaveBeenCalledWith(
        '[useAnnotationPanel] annotation:ref-update event received:',
        annotationId,
        'element provided'
      );

      consoleLog.mockRestore();
    });
  });
});
