import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CommentsPanel } from '../CommentsPanel';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      title: 'Comments',
      noComments: 'No comments yet. Select text to add a comment.',
      commentPlaceholder: 'Add your comment...',
      save: 'Save',
    };
    return translations[key] || key;
  }),
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
  CommentEntry: ({ comment, onClick, onDelete, onUpdate, onCommentRef, onAnnotationHover }: any) => (
    <div
      data-testid={`comment-${comment.id}`}
      onClick={() => onClick()}
    >
      <button onClick={() => onDelete()}>Delete</button>
      <button onClick={() => onUpdate('updated text')}>Update</button>
      <button
        onMouseEnter={() => onAnnotationHover?.(comment.id)}
        onMouseLeave={() => onAnnotationHover?.(null)}
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

describe('CommentsPanel Component', () => {
  const defaultProps = {
    annotations: mockComments.empty,
    onAnnotationClick: vi.fn(),
    onUpdate: vi.fn(),
    focusedAnnotationId: null,
    resourceContent: 'This is the resource content for testing comments.',
    pendingSelection: null,
  };

  beforeEach(() => {
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
      render(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);

      expect(screen.getByText(/Comments/)).toBeInTheDocument();
      expect(screen.getByText(/\(3\)/)).toBeInTheDocument();
    });

    it('should show empty state when no comments', () => {
      render(<CommentsPanel {...defaultProps} />);

      expect(screen.getByText(/No comments yet/)).toBeInTheDocument();
    });

    it('should render all comments', () => {
      render(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);

      expect(screen.getByTestId('comment-1')).toBeInTheDocument();
      expect(screen.getByTestId('comment-2')).toBeInTheDocument();
      expect(screen.getByTestId('comment-3')).toBeInTheDocument();
    });

    it('should have proper panel structure', () => {
      const { container } = render(<CommentsPanel {...defaultProps} />);

      // Find the root panel div (first child of the container)
      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('flex', 'flex-col', 'h-full');
    });

    it('should have scrollable comments list', () => {
      const { container } = render(
        <CommentsPanel {...defaultProps} annotations={mockComments.many} />
      );

      const commentsList = container.querySelector('.overflow-y-auto');
      expect(commentsList).toBeInTheDocument();
      expect(commentsList).toHaveClass('flex-1', 'p-4');
    });
  });

  describe('Comment Sorting', () => {
    it('should sort comments by position in resource', () => {
      render(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);

      const comments = screen.getAllByTestId(/comment-/);

      // Should be sorted by start position: comment-2 (0), comment-1 (50), comment-3 (100)
      expect(comments[0]).toHaveAttribute('data-testid', 'comment-2');
      expect(comments[1]).toHaveAttribute('data-testid', 'comment-1');
      expect(comments[2]).toHaveAttribute('data-testid', 'comment-3');
    });

    it('should handle comments without valid selectors', () => {
      mockGetTextPositionSelector.mockReturnValue(null);

      expect(() => {
        render(<CommentsPanel {...defaultProps} annotations={mockComments.multiple} />);
      }).not.toThrow();
    });

    it('should maintain sort order when comments update', () => {
      const { rerender } = render(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      // Add a new comment at position 25
      const updatedComments = [
        ...mockComments.multiple,
        createMockComment('4', 25, 35),
      ];

      rerender(<CommentsPanel {...defaultProps} annotations={updatedComments} />);

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
      render(<CommentsPanel {...defaultProps} />);

      expect(screen.queryByPlaceholderText(/Add your comment/)).not.toBeInTheDocument();
    });

    it('should show new comment input when pendingSelection exists', () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      expect(screen.getByPlaceholderText(/Add your comment/)).toBeInTheDocument();
    });

    it('should display quoted selected text in new comment area', () => {
      const pendingSelection = {
        exact: 'Selected text for comment',
        start: 10,
        end: 35,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      expect(screen.getByText(/"Selected text for comment"/)).toBeInTheDocument();
    });

    it('should truncate long selected text at 100 characters', () => {
      const longText = 'A'.repeat(150);
      const pendingSelection = {
        exact: longText,
        start: 0,
        end: 150,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      expect(screen.getByText(new RegExp(`"${'A'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should allow typing in new comment textarea', async () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'My new comment');

      expect(textarea).toHaveValue('My new comment');
    });

    it('should show character count', async () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      expect(screen.getByText('0/2000')).toBeInTheDocument();

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'Test');

      expect(screen.getByText('4/2000')).toBeInTheDocument();
    });

    it('should enforce maxLength of 2000 characters', () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/) as HTMLTextAreaElement;
      expect(textarea).toHaveAttribute('maxLength', '2000');
    });

    it('should auto-focus new comment textarea', () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      expect(textarea).toHaveFocus();
    });

    it('should call onCreateComment when save is clicked', async () => {
      const onCreateComment = vi.fn();
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={onCreateComment}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'My new comment');

      const saveButton = screen.getByText('Save');
      await userEvent.click(saveButton);

      expect(onCreateComment).toHaveBeenCalledWith('My new comment');
    });

    it('should clear textarea after successful save', async () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'My new comment');
      await userEvent.click(screen.getByText('Save'));

      expect(textarea).toHaveValue('');
    });

    it('should disable save button when textarea is empty', () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const saveButton = screen.getByText('Save');
      expect(saveButton).toBeDisabled();
    });

    it('should disable save button when textarea contains only whitespace', async () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, '   ');

      const saveButton = screen.getByText('Save');
      expect(saveButton).toBeDisabled();
    });

    it('should enable save button when text is entered', async () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      await userEvent.type(textarea, 'Valid comment');

      const saveButton = screen.getByText('Save');
      expect(saveButton).not.toBeDisabled();
    });

    it('should have proper styling for new comment area', () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      const { container } = render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const newCommentArea = container.querySelector('.bg-purple-50');
      expect(newCommentArea).toBeInTheDocument();
      // Check for the dark mode class (dark:bg-purple-900/10)
      expect(newCommentArea?.className).toContain('dark:bg-purple-900/10');
    });
  });

  describe('Comment Interactions', () => {
    it('should call onCommentClick when comment is clicked', () => {
      const onCommentClick = vi.fn();
      render(
        <CommentsPanel
          {...defaultProps}
          annotations={mockComments.single}
          onAnnotationClick={onCommentClick}
        />
      );

      const comment = screen.getByTestId('comment-1');
      fireEvent.click(comment);

      expect(onCommentClick).toHaveBeenCalledWith(mockComments.single[0]);
    });

    it('should call onUpdateComment with annotation id and new text', () => {
      const onUpdateComment = vi.fn();
      render(
        <CommentsPanel
          {...defaultProps}
          annotations={mockComments.single}
          onUpdate={onUpdateComment}
        />
      );

      const updateButton = screen.getByText('Update');
      fireEvent.click(updateButton);

      expect(onUpdateComment).toHaveBeenCalledWith('1', 'updated text');
    });
  });

  describe('Comment Hover Behavior', () => {
    it('should call onAnnotationHover when provided', () => {
      const onAnnotationHover = vi.fn();
      render(
        <CommentsPanel
          {...defaultProps}
          annotations={mockComments.single}
          onAnnotationHover={onAnnotationHover}
        />
      );

      const hoverButton = screen.getByText('Hover');
      fireEvent.mouseEnter(hoverButton);

      expect(onAnnotationHover).toHaveBeenCalledWith('1');
    });

    it('should handle hoveredAnnotationId prop changes', () => {
      const { rerender } = render(
        <CommentsPanel
          {...defaultProps}
          annotations={mockComments.multiple}
          hoveredAnnotationId={null}
        />
      );

      // Should not error when hoveredAnnotationId changes
      expect(() => {
        rerender(
          <CommentsPanel
            {...defaultProps}
            annotations={mockComments.multiple}
            hoveredAnnotationId="2"
          />
        );
      }).not.toThrow();

      // Should handle being set back to null
      expect(() => {
        rerender(
          <CommentsPanel
            {...defaultProps}
            annotations={mockComments.multiple}
            hoveredAnnotationId={null}
          />
        );
      }).not.toThrow();
    });

    it('should not error when onAnnotationHover is not provided', () => {
      expect(() => {
        render(
          <CommentsPanel
            {...defaultProps}
            annotations={mockComments.single}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Focus Management', () => {
    it('should pass focusedAnnotationId to CommentEntry components', () => {
      render(
        <CommentsPanel
          {...defaultProps}
          annotations={mockComments.multiple}
          focusedAnnotationId="2"
        />
      );

      // The focused comment should be rendered
      expect(screen.getByTestId('comment-2')).toBeInTheDocument();
    });

    it('should handle null focusedAnnotationId', () => {
      expect(() => {
        render(
          <CommentsPanel
            {...defaultProps}
            annotations={mockComments.multiple}
            focusedAnnotationId={null}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Panel Structure and Styling', () => {
    it('should have fixed header that does not scroll', () => {
      render(
        <CommentsPanel {...defaultProps} annotations={mockComments.many} />
      );

      const header = screen.getByText(/Comments/).closest('div');
      expect(header).toHaveClass('flex-shrink-0');
    });

    it('should support dark mode', () => {
      const { container } = render(<CommentsPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('dark:bg-gray-900');
    });

    it('should have proper spacing between comments', () => {
      const { container } = render(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      const commentsList = container.querySelector('.space-y-4');
      expect(commentsList).toBeInTheDocument();
    });

    it('should have proper border styling', () => {
      render(<CommentsPanel {...defaultProps} />);

      const header = screen.getByText(/Comments/).closest('div');
      expect(header).toHaveClass('border-b', 'border-gray-200', 'dark:border-gray-700');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty comments array', () => {
      expect(() => {
        render(<CommentsPanel {...defaultProps} annotations={[]} />);
      }).not.toThrow();

      expect(screen.getByText(/No comments yet/)).toBeInTheDocument();
    });

    it('should handle rapid comment additions', () => {
      const { rerender } = render(
        <CommentsPanel {...defaultProps} annotations={mockComments.empty} />
      );

      for (let i = 1; i <= 5; i++) {
        const comments = Array.from({ length: i }, (_, j) =>
          createMockComment(`${j + 1}`, j * 10, (j + 1) * 10)
        );
        rerender(<CommentsPanel {...defaultProps} annotations={comments} />);
      }

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(5);
    });

    it('should handle comment removal', () => {
      const { rerender } = render(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(3);

      rerender(
        <CommentsPanel {...defaultProps} annotations={mockComments.single} />
      );

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(1);
    });

    it('should handle missing onCreateComment callback', () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
        />
      );

      // Should not show new comment input if onCreateComment is not provided
      expect(screen.queryByPlaceholderText(/Add your comment/)).not.toBeInTheDocument();
    });

    it('should handle very large number of comments', () => {
      const manyComments = Array.from({ length: 100 }, (_, i) =>
        createMockComment(`${i + 1}`, i * 10, (i + 1) * 10)
      );

      expect(() => {
        render(<CommentsPanel {...defaultProps} annotations={manyComments} />);
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
        render(<CommentsPanel {...defaultProps} annotations={commentsAtSamePosition} />);
      }).not.toThrow();

      expect(screen.getAllByTestId(/comment-/)).toHaveLength(3);
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      render(<CommentsPanel {...defaultProps} />);

      const heading = screen.getByText(/Comments/);
      expect(heading).toHaveClass('text-lg', 'font-semibold');
    });

    it('should have proper textarea attributes for new comments', () => {
      const pendingSelection = {
        exact: 'Selected text',
        start: 10,
        end: 23,
      };

      render(
        <CommentsPanel
          {...defaultProps}
          pendingSelection={pendingSelection}
          onCreate={vi.fn()}
        />
      );

      const textarea = screen.getByPlaceholderText(/Add your comment/);
      expect(textarea).toHaveAttribute('rows', '3');
    });

    it('should have semantic HTML structure', () => {
      const { container } = render(
        <CommentsPanel {...defaultProps} annotations={mockComments.multiple} />
      );

      // Panel should be a properly structured div hierarchy
      expect(container.querySelector('.flex.flex-col.h-full')).toBeInTheDocument();
    });
  });
});
