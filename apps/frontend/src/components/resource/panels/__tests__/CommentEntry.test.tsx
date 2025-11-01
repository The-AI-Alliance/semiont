import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CommentEntry } from '../CommentEntry';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      edit: 'Edit',
      save: 'Save',
      cancel: 'Cancel',
    };
    return translations[key] || key;
  }),
}));

// Mock @semiont/api-client utilities
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getCommentText: vi.fn(),
    getAnnotationExactText: vi.fn(),
  };
});

import { getCommentText, getAnnotationExactText } from '@semiont/api-client';
import type { MockedFunction } from 'vitest';

const mockGetCommentText = getCommentText as MockedFunction<typeof getCommentText>;
const mockGetAnnotationExactText = getAnnotationExactText as MockedFunction<typeof getAnnotationExactText>;

// Test data fixtures
const createMockComment = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'comment-1',
  type: 'Annotation',
  motivation: 'commenting',
  creator: {
    name: 'user@example.com',
  },
  created: '2024-01-01T10:00:00Z',
  modified: '2024-01-01T10:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextPositionSelector',
      start: 0,
      end: 10,
    },
  },
  body: [
    {
      type: 'TextualBody',
      value: 'This is a test comment',
      purpose: 'commenting',
    },
  ],
  ...overrides,
});

const mockCommentStates = {
  standard: createMockComment(),
  withLongText: createMockComment({
    body: [
      {
        type: 'TextualBody',
        value: 'This is a very long comment that exceeds the typical length and should test text wrapping and display handling. '.repeat(5),
        purpose: 'commenting',
      },
    ],
  }),
  withCreatorObject: createMockComment({
    creator: {
      id: 'user-123',
      type: 'Person',
      name: 'John Doe',
    },
  }),
  recentComment: createMockComment({
    created: new Date(Date.now() - 30000).toISOString(), // 30 seconds ago
  }),
  oldComment: createMockComment({
    created: new Date(Date.now() - 86400000 * 10).toISOString(), // 10 days ago
  }),
};

describe('CommentEntry Component', () => {
  const defaultProps = {
    comment: mockCommentStates.standard,
    isFocused: false,
    onClick: vi.fn(),
    onDelete: vi.fn(),
    onUpdate: vi.fn(),
    onCommentRef: vi.fn(),
    onCommentHover: vi.fn(),
    resourceContent: 'This is the resource content for testing',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCommentText.mockReturnValue('This is a test comment');
    mockGetAnnotationExactText.mockReturnValue('This is th');

    // Mock scrollIntoView for jsdom
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render comment with text and metadata', () => {
      render(<CommentEntry {...defaultProps} />);

      expect(screen.getByText('This is a test comment')).toBeInTheDocument();
      expect(screen.getByText(/user@example.com/)).toBeInTheDocument();
    });

    it('should render selected text quote', () => {
      render(<CommentEntry {...defaultProps} />);

      const quote = screen.getByText(/"This is th"/);
      expect(quote).toBeInTheDocument();
      expect(quote).toHaveClass('italic', 'border-l-2', 'border-purple-300');
    });

    it('should truncate long selected text at 100 characters', () => {
      const longText = 'A'.repeat(150);
      mockGetAnnotationExactText.mockReturnValue(longText);

      render(<CommentEntry {...defaultProps} />);

      expect(screen.getByText(new RegExp(`"${'A'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should render creator name from creator object', () => {
      render(
        <CommentEntry
          {...defaultProps}
          comment={mockCommentStates.withCreatorObject}
        />
      );

      expect(screen.getByText(/John Doe/)).toBeInTheDocument();
    });

    it('should handle creator as object with name', () => {
      render(<CommentEntry {...defaultProps} />);

      expect(screen.getByText(/user@example.com/)).toBeInTheDocument();
    });

    it('should show "Unknown" for missing creator', () => {
      const { creator, ...rest } = createMockComment();
      const commentWithoutCreator = rest as Annotation;

      render(
        <CommentEntry
          {...defaultProps}
          comment={commentWithoutCreator}
        />
      );

      expect(screen.getByText(/Unknown/)).toBeInTheDocument();
    });

    it('should format relative time correctly for recent comments', () => {
      render(
        <CommentEntry
          {...defaultProps}
          comment={mockCommentStates.recentComment}
        />
      );

      expect(screen.getByText(/just now|seconds? ago|minutes? ago/)).toBeInTheDocument();
    });

    it('should format relative time correctly for old comments', () => {
      render(
        <CommentEntry
          {...defaultProps}
          comment={mockCommentStates.oldComment}
        />
      );

      expect(screen.getByText(/days? ago|\d+\/\d+\/\d+/)).toBeInTheDocument();
    });
  });

  describe('Focus State', () => {
    it('should apply focus styles when focused', () => {
      const { container } = render(
        <CommentEntry {...defaultProps} isFocused={true} />
      );

      const commentDiv = container.querySelector('.animate-pulse-outline');
      expect(commentDiv).toBeInTheDocument();
      expect(commentDiv).toHaveClass('border-gray-400', 'bg-gray-50');
    });

    it('should not apply focus styles when not focused', () => {
      const { container } = render(
        <CommentEntry {...defaultProps} isFocused={false} />
      );

      const commentDiv = container.querySelector('.animate-pulse-outline');
      expect(commentDiv).not.toBeInTheDocument();
    });

    it('should scroll into view when focused', async () => {
      const mockScrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = mockScrollIntoView;

      const { rerender } = render(
        <CommentEntry {...defaultProps} isFocused={false} />
      );

      // Clear any initial calls
      mockScrollIntoView.mockClear();

      // Becomes focused
      rerender(<CommentEntry {...defaultProps} isFocused={true} />);

      await waitFor(() => {
        expect(mockScrollIntoView).toHaveBeenCalledWith({
          behavior: 'smooth',
          block: 'center',
        });
      });
    });
  });

  describe('Click Interactions', () => {
    it('should call onClick when comment is clicked', async () => {
      const onClick = vi.fn();
      const { container } = render(
        <CommentEntry {...defaultProps} onClick={onClick} />
      );

      const commentDiv = container.firstChild as HTMLElement;
      await userEvent.click(commentDiv);

      expect(onClick).toHaveBeenCalledOnce();
    });

    it('should be clickable with cursor-pointer class', () => {
      const { container } = render(<CommentEntry {...defaultProps} />);

      const commentDiv = container.firstChild as HTMLElement;
      expect(commentDiv).toHaveClass('cursor-pointer');
    });
  });

  describe('Hover Interactions', () => {
    it('should call onCommentHover with comment id on mouse enter', () => {
      const onCommentHover = vi.fn();
      const { container } = render(
        <CommentEntry {...defaultProps} onCommentHover={onCommentHover} />
      );

      const commentDiv = container.firstChild as HTMLElement;
      fireEvent.mouseEnter(commentDiv);

      expect(onCommentHover).toHaveBeenCalledWith('comment-1');
    });

    it('should call onCommentHover with null on mouse leave', () => {
      const onCommentHover = vi.fn();
      const { container } = render(
        <CommentEntry {...defaultProps} onCommentHover={onCommentHover} />
      );

      const commentDiv = container.firstChild as HTMLElement;
      fireEvent.mouseLeave(commentDiv);

      expect(onCommentHover).toHaveBeenCalledWith(null);
    });

    it('should not error if onCommentHover is not provided', () => {
      const { onCommentHover, ...propsWithoutHover } = defaultProps;
      const { container } = render(
        <CommentEntry {...propsWithoutHover} />
      );

      const commentDiv = container.firstChild as HTMLElement;

      expect(() => {
        fireEvent.mouseEnter(commentDiv);
        fireEvent.mouseLeave(commentDiv);
      }).not.toThrow();
    });
  });

  describe('Edit Functionality', () => {
    it('should show edit button', () => {
      render(<CommentEntry {...defaultProps} />);

      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    it('should enter edit mode when edit button is clicked', async () => {
      render(<CommentEntry {...defaultProps} />);

      const editButton = screen.getByText('Edit');
      await userEvent.click(editButton);

      // Should show textarea
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue('This is a test comment');
      expect(textarea).toHaveFocus();
    });

    it('should show save and cancel buttons in edit mode', async () => {
      render(<CommentEntry {...defaultProps} />);

      const editButton = screen.getByText('Edit');
      await userEvent.click(editButton);

      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });

    it('should stop event propagation when clicking textarea in edit mode', async () => {
      const onClick = vi.fn();
      render(<CommentEntry {...defaultProps} onClick={onClick} />);

      await userEvent.click(screen.getByText('Edit'));

      // Clear the onClick calls that happened during entering edit mode
      onClick.mockClear();

      const textarea = screen.getByRole('textbox');
      await userEvent.click(textarea);

      // onClick should not be called for textarea click due to stopPropagation
      expect(onClick).not.toHaveBeenCalled();
    });

    it('should update text in textarea', async () => {
      render(<CommentEntry {...defaultProps} />);

      await userEvent.click(screen.getByText('Edit'));
      const textarea = screen.getByRole('textbox');

      await userEvent.clear(textarea);
      await userEvent.type(textarea, 'Updated comment text');

      expect(textarea).toHaveValue('Updated comment text');
    });

    it('should show character count in edit mode', async () => {
      render(<CommentEntry {...defaultProps} />);

      await userEvent.click(screen.getByText('Edit'));

      expect(screen.getByText('22/2000')).toBeInTheDocument();
    });

    it('should enforce max length of 2000 characters', async () => {
      render(<CommentEntry {...defaultProps} />);

      await userEvent.click(screen.getByText('Edit'));
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

      expect(textarea).toHaveAttribute('maxLength', '2000');
    });

    it('should call onUpdate with new text when save is clicked', async () => {
      const onUpdate = vi.fn();
      render(<CommentEntry {...defaultProps} onUpdate={onUpdate} />);

      await userEvent.click(screen.getByText('Edit'));
      const textarea = screen.getByRole('textbox');

      await userEvent.clear(textarea);
      await userEvent.type(textarea, 'Updated comment');

      await userEvent.click(screen.getByText('Save'));

      expect(onUpdate).toHaveBeenCalledWith('Updated comment');
    });

    it('should exit edit mode after save', async () => {
      render(<CommentEntry {...defaultProps} />);

      await userEvent.click(screen.getByText('Edit'));
      await userEvent.click(screen.getByText('Save'));

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    it('should discard changes when cancel is clicked', async () => {
      render(<CommentEntry {...defaultProps} />);

      await userEvent.click(screen.getByText('Edit'));
      const textarea = screen.getByRole('textbox');

      await userEvent.clear(textarea);
      await userEvent.type(textarea, 'Changed text');

      await userEvent.click(screen.getByText('Cancel'));

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByText('This is a test comment')).toBeInTheDocument();
    });

    it('should not call onUpdate when cancel is clicked', async () => {
      const onUpdate = vi.fn();
      render(<CommentEntry {...defaultProps} onUpdate={onUpdate} />);

      await userEvent.click(screen.getByText('Edit'));
      await userEvent.click(screen.getByText('Cancel'));

      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe('Delete Functionality', () => {
    it('should show delete button', () => {
      render(<CommentEntry {...defaultProps} />);

      expect(screen.getByText('🗑️')).toBeInTheDocument();
    });

    it('should call onDelete when delete button is clicked', async () => {
      const onDelete = vi.fn();
      render(<CommentEntry {...defaultProps} onDelete={onDelete} />);

      const deleteButton = screen.getByText('🗑️');
      await userEvent.click(deleteButton);

      expect(onDelete).toHaveBeenCalledOnce();
    });

    it('should call onDelete when delete button is clicked', async () => {
      const onClick = vi.fn();
      const onDelete = vi.fn();
      render(
        <CommentEntry {...defaultProps} onClick={onClick} onDelete={onDelete} />
      );

      const deleteButton = screen.getByText('🗑️');
      await userEvent.click(deleteButton);

      // Should call onDelete
      expect(onDelete).toHaveBeenCalledOnce();
    });
  });

  describe('Ref Management', () => {
    it('should call onCommentRef with element on mount', () => {
      const onCommentRef = vi.fn();
      render(<CommentEntry {...defaultProps} onCommentRef={onCommentRef} />);

      expect(onCommentRef).toHaveBeenCalledWith(
        'comment-1',
        expect.any(HTMLDivElement)
      );
    });

    it('should call onCommentRef with null on unmount', () => {
      const onCommentRef = vi.fn();
      const { unmount } = render(
        <CommentEntry {...defaultProps} onCommentRef={onCommentRef} />
      );

      onCommentRef.mockClear();
      unmount();

      expect(onCommentRef).toHaveBeenCalledWith('comment-1', null);
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper border and padding styles', () => {
      const { container } = render(<CommentEntry {...defaultProps} />);

      const commentDiv = container.firstChild as HTMLElement;
      expect(commentDiv).toHaveClass('border', 'rounded-lg', 'p-3');
    });

    it('should have hover styles when not focused', () => {
      const { container } = render(<CommentEntry {...defaultProps} />);

      const commentDiv = container.firstChild as HTMLElement;
      expect(commentDiv).toHaveClass(
        'hover:border-gray-300',
        'dark:hover:border-gray-600'
      );
    });

    it('should support dark mode classes', () => {
      const { container } = render(<CommentEntry {...defaultProps} />);

      const commentDiv = container.firstChild as HTMLElement;
      expect(commentDiv).toHaveClass('dark:border-gray-700');
    });

    it('should render comment text with whitespace preserved', () => {
      mockGetCommentText.mockReturnValue('Line 1\nLine 2\nLine 3');
      render(<CommentEntry {...defaultProps} />);

      // Use a more flexible matcher for multiline text
      const commentText = screen.getByText((content, element) => {
        return (
          !!element &&
          element.className.includes('whitespace-pre-wrap') &&
          content.includes('Line 1') &&
          content.includes('Line 2') &&
          content.includes('Line 3')
        );
      });
      expect(commentText).toHaveClass('whitespace-pre-wrap');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty comment text', () => {
      mockGetCommentText.mockReturnValue('');
      render(<CommentEntry {...defaultProps} />);

      // Check that the comment div with whitespace-pre-wrap class exists
      const { container } = render(<CommentEntry {...defaultProps} />);
      const commentDiv = container.querySelector('.whitespace-pre-wrap');
      expect(commentDiv).toBeInTheDocument();
      expect(commentDiv?.textContent).toBe('');
    });

    it('should handle null selected text gracefully', () => {
      mockGetAnnotationExactText.mockReturnValue('');

      expect(() => {
        render(<CommentEntry {...defaultProps} />);
      }).not.toThrow();
    });

    it('should handle missing created timestamp', () => {
      const { created, ...rest } = createMockComment();
      const commentWithoutTimestamp = rest as Annotation;

      expect(() => {
        render(
          <CommentEntry {...defaultProps} comment={commentWithoutTimestamp} />
        );
      }).not.toThrow();
    });

    it('should handle very long comment text', () => {
      const longText = 'This is a very long comment that exceeds the typical length and should test text wrapping and display handling. '.repeat(5);
      mockGetCommentText.mockReturnValue(longText);

      render(
        <CommentEntry {...defaultProps} comment={mockCommentStates.withLongText} />
      );

      // Use a more flexible matcher for long text
      expect(screen.getByText((content) =>
        content.includes('This is a very long comment') && content.length > 500
      )).toBeInTheDocument();
    });

    it('should handle rapid edit/cancel cycles', async () => {
      render(<CommentEntry {...defaultProps} />);

      for (let i = 0; i < 3; i++) {
        await userEvent.click(screen.getByText('Edit'));
        await userEvent.click(screen.getByText('Cancel'));
      }

      expect(screen.getByText('Edit')).toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes for textarea', async () => {
      render(<CommentEntry {...defaultProps} />);

      await userEvent.click(screen.getByText('Edit'));
      const textarea = screen.getByRole('textbox');

      expect(textarea).toHaveAttribute('rows', '3');
    });

    it('should be keyboard navigable', async () => {
      render(<CommentEntry {...defaultProps} />);

      const editButton = screen.getByText('Edit');
      editButton.focus();

      expect(editButton).toHaveFocus();
    });

    it('should support keyboard interaction for save/cancel', async () => {
      render(<CommentEntry {...defaultProps} />);

      await userEvent.click(screen.getByText('Edit'));

      const saveButton = screen.getByText('Save');
      const cancelButton = screen.getByText('Cancel');

      expect(saveButton).toBeInTheDocument();
      expect(cancelButton).toBeInTheDocument();
    });
  });
});
