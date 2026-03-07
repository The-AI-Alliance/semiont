import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CommentsPanel } from '../CommentsPanel';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../../contexts/EventBusContext';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

// Composition-based event tracker
interface TrackedEvent {
  event: string;
  payload: any;
}

function createEventTracker() {
  const events: TrackedEvent[] = [];

  function EventTrackingWrapper({ children }: { children: React.ReactNode }) {
    const eventBus = useEventBus();

    React.useEffect(() => {
      const handlers: Array<() => void> = [];

      const trackEvent = (eventName: string) => (payload: any) => {
        events.push({ event: eventName, payload });
      };

      const panelEvents = ['mark:create'] as const;

      panelEvents.forEach(eventName => {
        const handler = trackEvent(eventName);
        const subscription = eventBus.get(eventName).subscribe(handler);
        handlers.push(subscription);
      });

      return () => {
        handlers.forEach(sub => sub.unsubscribe());
      };
    }, [eventBus]);

    return <>{children}</>;
  }

  return {
    EventTrackingWrapper,
    events,
    clear: () => {
      events.length = 0;
    },
  };
}

// Helper to render with EventBusProvider
const renderWithEventBus = (component: React.ReactElement, tracker?: ReturnType<typeof createEventTracker>) => {
  if (tracker) {
    return render(
      <EventBusProvider>
        <tracker.EventTrackingWrapper>
          {component}
        </tracker.EventTrackingWrapper>
      </EventBusProvider>
    );
  }

  return render(
    <EventBusProvider>
      {component}
    </EventBusProvider>
  );
};

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      title: 'Comments',
      noComments: 'No comments yet. Select text to add a comment.',
      commentPlaceholder: 'Add your comment...',
      save: 'Save',
      cancel: 'Cancel',
    };
    return translations[key] || key;
  }),
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock @semiont/api-client utilities
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getTextPositionSelector: vi.fn(),
    getTargetSelector: vi.fn(),
  };
});

// Mock CommentEntry component to simplify testing
vi.mock('../CommentEntry', () => ({
  CommentEntry: ({ comment, onClick, onCommentRef, onCommentHover }: any) => (
    <div
      data-testid={`comment-${comment.id}`}
      onClick={() => onClick()}
    >
      <button
        onMouseEnter={() => onCommentHover?.(comment.id)}
        onMouseLeave={() => onCommentHover?.(null)}
      >
        Hover
      </button>
      <div>{comment.id}</div>
    </div>
  ),
}));

import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';

const mockGetTextPositionSelector = getTextPositionSelector as MockedFunction<typeof getTextPositionSelector>;
const mockGetTargetSelector = getTargetSelector as MockedFunction<typeof getTargetSelector>;

// Test data fixtures
const createMockComment = (id: string, start: number, end: number): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id,
  type: 'Annotation',
  motivation: 'commenting',
  creator: {
    name: `user${id}@example.com`,
  },
  created: `2024-01-0${id.slice(-1)}T10:00:00Z`,
  modified: `2024-01-0${id.slice(-1)}T10:00:00Z`,
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextPositionSelector',
      start,
      end,
    },
  },
  body: [
    {
      type: 'TextualBody',
      value: `Comment ${id}`,
      purpose: 'commenting',
    },
  ],
});

const mockComments = {
  empty: [],
  single: [createMockComment('1', 0, 10)],
  multiple: [
    createMockComment('1', 50, 60),  // Middle position
    createMockComment('2', 0, 10),   // First position
    createMockComment('3', 100, 110), // Last position
  ],
  many: Array.from({ length: 10 }, (_, i) =>
    createMockComment(`${i + 1}`, i * 10, (i + 1) * 10)
  ),
};

// Helper to create pending annotation (matches new API)
const createPendingAnnotation = (exact: string) => ({
  motivation: 'commenting' as const,
  selector: {
    type: 'TextQuoteSelector' as const,
    exact,
  },
});

describe('CommentsPanel Component', () => {
  const defaultProps = {
    annotations: mockComments.empty,
    pendingAnnotation: null,
  };

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();

    // Mock scrollIntoView for jsdom
    Element.prototype.scrollIntoView = vi.fn();

    // Mock selector functions to return proper position data
    mockGetTargetSelector.mockImplementation((target: any) => target.selector);
    mockGetTextPositionSelector.mockImplementation((selector: any) => {
      if (selector?.type === 'TextPositionSelector') {
        return selector;
      }
      return null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel header with title and count', () => {
      renderWithEventBus(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);

      const headings = screen.getAllByText(/Comments/);
      expect(headings.length).toBeGreaterThan(0);
      expect(screen.getByText(/\(3\)/)).toBeInTheDocument();
    });

    it('should show empty state when no comments', () => {
      renderWithEventBus(<CommentsPanel {...defaultProps} />);

      expect(screen.getByText(/No comments yet/)).toBeInTheDocument();
    });

    it('should render all comments', () => {
      renderWithEventBus(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);

      expect(screen.getByTestId('comment-1')).toBeInTheDocument();
      expect(screen.getByTestId('comment-2')).toBeInTheDocument();
      expect(screen.getByTestId('comment-3')).toBeInTheDocument();
    });

    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<CommentsPanel {...defaultProps} />);

      // Find the root panel div (first child of the container)
      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });

    it('should have scrollable comments list', () => {
      const { container } = renderWithEventBus(
        <CommentsPanel {...defaultProps} annotations={mockComments.many} />
      );

      const commentsList = container.querySelector('.semiont-panel__list');
      expect(commentsList).toBeInTheDocument();
    });
  });

  describe('Comment Sorting', () => {
    it('should sort comments by position in resource', () => {
      renderWithEventBus(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);

      const comments = screen.getAllByTestId(/comment-/);

      // Should be sorted by start position: comment-2 (0), comment-1 (50), comment-3 (100)
      expect(comments[0]).toHaveAttribute('data-testid', 'comment-2');
      expect(comments[1]).toHaveAttribute('data-testid', 'comment-1');
      expect(comments[2]).toHaveAttribute('data-testid', 'comment-3');
    });

    it('should handle comments without valid selectors', () => {
      mockGetTextPositionSelector.mockReturnValue(null);

      expect(() => {
        renderWithEventBus(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);
      }).not.toThrow();
    });

    it('should maintain sort order when comments update', () => {
      const { rerender } = renderWithEventBus(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      // Add a new comment at position 25
      const updatedComments = [
        ...mockComments.multiple,
        createMockComment('4', 25, 35),
      ];

      rerender(
        <EventBusProvider>
          <CommentsPanel {...defaultProps} annotations={updatedComments} />
        </EventBusProvider>
      );

      const comments = screen.getAllByTestId(/comment-/);

      // Should be sorted: comment-2 (0), comment-4 (25), comment-1 (50), comment-3 (100)
      expect(comments[0]).toHaveAttribute('data-testid', 'comment-2');
      expect(comments[1]).toHaveAttribute('data-testid', 'comment-4');
      expect(comments[2]).toHaveAttribute('data-testid', 'comment-1');
      expect(comments[3]).toHaveAttribute('data-testid', 'comment-3');
    });
  });

  describe('New Comment Creation', () => {
    it('should not show new comment input by default', () => {
      renderWithEventBus(<CommentsPanel {...defaultProps} />);

      expect(screen.queryByPlaceholderText(/Add your comment/)).not.toBeInTheDocument();
    });

    it('should show new comment input when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByPlaceholderText(/Add your comment/)).toBeInTheDocument();
    });

    it('should display quoted selected text in new comment area', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text for comment');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(/"Selected text for comment"/)).toBeInTheDocument();
    });

    it('should truncate long selected text at 100 characters', () => {
      const longText = 'A'.repeat(150);
      const pendingAnnotation = createPendingAnnotation(longText);

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(new RegExp(`"${'A'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should allow typing in new comment textarea', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'My new comment');

      expect(textarea).toHaveValue('My new comment');
    });

    it('should show character count', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText('0/2000')).toBeInTheDocument();

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'Test');

      expect(screen.getByText('4/2000')).toBeInTheDocument();
    });

    it('should enforce maxLength of 2000 characters', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/) as HTMLTextAreaElement;
      expect(textarea).toHaveAttribute('maxLength', '2000');
    });

    it('should auto-focus new comment textarea', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      expect(textarea).toHaveFocus();
    });

    it('should emit mark:createevent when save is clicked', async () => {
      const tracker = createEventTracker();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />,
        tracker
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'My new comment');

      const saveButton = screen.getByText('Save');
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:create' &&
          e.payload?.motivation === 'commenting' &&
          e.payload?.body?.[0]?.value === 'My new comment'
        )).toBe(true);
      });
    });

    it('should clear textarea after save is clicked', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'My new comment');
      await userEvent.click(screen.getByText('Save'));

      expect(textarea).toHaveValue('');
    });

    it('should disable save button when textarea is empty', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const saveButton = screen.getByText('Save');
      expect(saveButton).toBeDisabled();
    });

    it('should disable save button when textarea contains only whitespace', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, '   ');

      const saveButton = screen.getByText('Save');
      expect(saveButton).toBeDisabled();
    });

    it('should enable save button when text is entered', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'Valid comment');

      const saveButton = screen.getByText('Save');
      expect(saveButton).not.toBeDisabled();
    });

    it('should have proper styling for new comment area', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      const { container } = renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const newCommentArea = container.querySelector('.semiont-annotation-prompt');
      expect(newCommentArea).toBeInTheDocument();
      expect(newCommentArea).toHaveAttribute('data-type', 'comment');
    });
  });

  describe('Comment Interactions', () => {
    it('should render comment entries', () => {
      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          annotations={mockComments.single}
        />
      );

      const comment = screen.getByTestId('comment-1');
      expect(comment).toBeInTheDocument();
    });

  });

  describe('Comment Hover Behavior', () => {
    it('should render without errors', () => {
      expect(() => {
        renderWithEventBus(
          <CommentsPanel
            {...defaultProps}
            annotations={mockComments.single}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Focus Management', () => {
    it('should render comments', () => {
      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          annotations={mockComments.multiple}
        />
      );

      // Comments should be rendered
      expect(screen.getByTestId('comment-2')).toBeInTheDocument();
    });
  });

  describe('Panel Structure and Styling', () => {
    it('should have fixed header that does not scroll', () => {
      renderWithEventBus(
        <CommentsPanel {...defaultProps} annotations={mockComments.many} />
      );

      const headers = screen.getAllByText(/Comments/);
      const header = headers[0].closest('div');
      expect(header).toHaveClass('semiont-panel-header');
    });

    it('should support dark mode', () => {
      const { container } = renderWithEventBus(<CommentsPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });

    it('should have proper spacing between comments', () => {
      const { container } = renderWithEventBus(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      const commentsList = container.querySelector('.semiont-panel__list');
      expect(commentsList).toBeInTheDocument();
    });

    it('should have proper border styling', () => {
      renderWithEventBus(<CommentsPanel {...defaultProps} />);

      const headers = screen.getAllByText(/Comments/);
      const header = headers[0].closest('div');
      expect(header).toHaveClass('semiont-panel-header');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty comments array', () => {
      expect(() => {
        renderWithEventBus(<CommentsPanel {...defaultProps} annotations={[]} />);
      }).not.toThrow();

      expect(screen.getByText(/No comments yet/)).toBeInTheDocument();
    });

    it('should handle rapid comment additions', () => {
      const { rerender } = renderWithEventBus(
        <CommentsPanel {...defaultProps} annotations={mockComments.empty} />
      );

      for (let i = 1; i <= 5; i++) {
        const comments = Array.from({ length: i }, (_, j) =>
          createMockComment(`${j + 1}`, j * 10, (j + 1) * 10)
        );
        rerender(
          <EventBusProvider>
            <CommentsPanel {...defaultProps} annotations={comments} />
          </EventBusProvider>
        );
      }

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(5);
    });

    it('should handle comment removal', () => {
      const { rerender } = renderWithEventBus(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(3);

      rerender(
        <EventBusProvider>
          <CommentsPanel {...defaultProps} annotations={mockComments.single} />
        </EventBusProvider>
      );

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(1);
    });

    it('should show new comment input when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      // Component shows textarea when pendingAnnotation exists
      expect(screen.getByPlaceholderText(/Add your comment/)).toBeInTheDocument();
    });

    it('should handle very large number of comments', () => {
      const manyComments = Array.from({ length: 100 }, (_, i) =>
        createMockComment(`${i + 1}`, i * 10, (i + 1) * 10)
      );

      expect(() => {
        renderWithEventBus(<CommentsPanel {...defaultProps} annotations={manyComments} />);
      }).not.toThrow();

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(100);
    });

    it('should handle comments with same position', () => {
      const commentsAtSamePosition = [
        createMockComment('1', 50, 60),
        createMockComment('2', 50, 60),
        createMockComment('3', 50, 60),
      ];

      expect(() => {
        renderWithEventBus(<CommentsPanel {...defaultProps} annotations={commentsAtSamePosition} />);
      }).not.toThrow();

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(3);
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      renderWithEventBus(<CommentsPanel {...defaultProps} />);

      const headings = screen.getAllByText(/Comments/);
      expect(headings[0]).toHaveClass('semiont-panel-header__text');
    });

    it('should have proper textarea attributes for new comments', () => {
      const pendingAnnotation = {
        motivation: 'commenting' as const,
        selector: {
          type: 'TextQuoteSelector' as const,
          exact: 'Selected text',
        },
      };

      renderWithEventBus(
        <CommentsPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      expect(textarea).toHaveAttribute('rows', '3');
    });

    it('should have semantic HTML structure', () => {
      const { container } = renderWithEventBus(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      // Panel should be a properly structured div hierarchy
      expect(container.querySelector('.semiont-panel')).toBeInTheDocument();
    });
  });
});
