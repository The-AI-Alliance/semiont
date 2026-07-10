import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResourceTagsInline } from '../ResourceTagsInline';

describe('ResourceTagsInline', () => {
  const mockOnUpdate = vi.fn(async () => {});
  const defaultProps = {
    resourceId: 'doc-123',
    tags: ['tag1', 'tag2', 'tag3'],
    isEditing: false,
    onUpdate: mockOnUpdate,
  };

  beforeEach(() => {
    mockOnUpdate.mockClear();
    mockOnUpdate.mockImplementation(async () => {});
  });

  describe('Rendering', () => {
    it('should render tags', () => {
      render(<ResourceTagsInline {...defaultProps} />);

      expect(screen.getByText('tag1')).toBeInTheDocument();
      expect(screen.getByText('tag2')).toBeInTheDocument();
      expect(screen.getByText('tag3')).toBeInTheDocument();
    });

    it('should render with correct classes', () => {
      const { container } = render(<ResourceTagsInline {...defaultProps} />);

      const wrapper = container.querySelector('.semiont-resource-tags-inline');
      expect(wrapper).toBeInTheDocument();

      const list = container.querySelector('.semiont-resource-tags-list');
      expect(list).toBeInTheDocument();
    });

    it('should render individual tags with correct class', () => {
      const { container } = render(<ResourceTagsInline {...defaultProps} />);

      const tags = container.querySelectorAll('.semiont-resource-tag');
      expect(tags).toHaveLength(3);
    });

    it('should return null when tags array is empty', () => {
      const { container } = render(
        <ResourceTagsInline {...defaultProps} tags={[]} />
      );

      expect(container.firstChild).toBeNull();
    });

    it('should render single tag', () => {
      render(<ResourceTagsInline {...defaultProps} tags={['solo-tag']} />);

      expect(screen.getByText('solo-tag')).toBeInTheDocument();
    });

    it('should render many tags', () => {
      const manyTags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
      render(<ResourceTagsInline {...defaultProps} tags={manyTags} />);

      manyTags.forEach(tag => {
        expect(screen.getByText(tag)).toBeInTheDocument();
      });
    });
  });

  describe('Props Handling', () => {
    it('should accept disabled prop without breaking', () => {
      render(<ResourceTagsInline {...defaultProps} disabled={true} />);

      expect(screen.getByText('tag1')).toBeInTheDocument();
    });

    it('should default disabled to false', () => {
      render(<ResourceTagsInline {...defaultProps} />);

      expect(screen.getByText('tag1')).toBeInTheDocument();
    });

    it('should work with different resourceId values', () => {
      const { rerender } = render(<ResourceTagsInline {...defaultProps} />);

      expect(screen.getByText('tag1')).toBeInTheDocument();

      rerender(<ResourceTagsInline {...defaultProps} resourceId="doc-456" />);

      expect(screen.getByText('tag1')).toBeInTheDocument();
    });
  });

  describe('Tag Display', () => {
    it('should preserve tag order', () => {
      const { container } = render(
        <ResourceTagsInline {...defaultProps} tags={['first', 'second', 'third']} />
      );

      const tagElements = container.querySelectorAll('.semiont-resource-tag');
      expect(tagElements[0].textContent).toBe('first');
      expect(tagElements[1].textContent).toBe('second');
      expect(tagElements[2].textContent).toBe('third');
    });

    it('should handle tags with special characters', () => {
      const specialTags = ['tag-with-dash', 'tag_with_underscore', 'tag.with.dots'];
      render(<ResourceTagsInline {...defaultProps} tags={specialTags} />);

      specialTags.forEach(tag => {
        expect(screen.getByText(tag)).toBeInTheDocument();
      });
    });

    it('should handle tags with spaces', () => {
      const tagsWithSpaces = ['multi word tag', 'another tag'];
      render(<ResourceTagsInline {...defaultProps} tags={tagsWithSpaces} />);

      tagsWithSpaces.forEach(tag => {
        expect(screen.getByText(tag)).toBeInTheDocument();
      });
    });

    it('should handle empty string tags', () => {
      const { container } = render(
        <ResourceTagsInline {...defaultProps} tags={['', 'valid-tag', '']} />
      );

      // All tags render, even empty ones
      const tagElements = container.querySelectorAll('.semiont-resource-tag');
      expect(tagElements).toHaveLength(3);
    });

    it('should handle very long tag names', () => {
      const longTag = 'a'.repeat(100);
      render(<ResourceTagsInline {...defaultProps} tags={[longTag]} />);

      expect(screen.getByText(longTag)).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle duplicate tags', () => {
      const { container } = render(
        <ResourceTagsInline {...defaultProps} tags={['duplicate', 'duplicate', 'unique']} />
      );

      // Note: React will warn about duplicate keys, but component still renders
      const tagElements = container.querySelectorAll('.semiont-resource-tag');
      expect(tagElements).toHaveLength(3);
    });

    it('should update when tags prop changes', () => {
      const { rerender } = render(<ResourceTagsInline {...defaultProps} />);

      expect(screen.getByText('tag1')).toBeInTheDocument();

      rerender(<ResourceTagsInline {...defaultProps} tags={['new-tag']} />);

      expect(screen.queryByText('tag1')).not.toBeInTheDocument();
      expect(screen.getByText('new-tag')).toBeInTheDocument();
    });

    it('should update from empty to non-empty', () => {
      const { container, rerender } = render(
        <ResourceTagsInline {...defaultProps} tags={[]} />
      );

      expect(container.firstChild).toBeNull();

      rerender(<ResourceTagsInline {...defaultProps} tags={['new-tag']} />);

      expect(screen.getByText('new-tag')).toBeInTheDocument();
    });

    it('should update from non-empty to empty', () => {
      const { container, rerender } = render(<ResourceTagsInline {...defaultProps} />);

      expect(screen.getByText('tag1')).toBeInTheDocument();

      rerender(<ResourceTagsInline {...defaultProps} tags={[]} />);

      expect(container.firstChild).toBeNull();
    });
  });

  // ── RESOURCE-TAGS-INLINE-EDITING: the declared contract, implemented ──

  describe('Editing mode', () => {
    it('browse mode renders no editing affordances (pins today’s rendering)', () => {
      const { container } = render(
        <ResourceTagsInline {...defaultProps} isEditing={false} vocabulary={['Person']} />,
      );
      expect(container.querySelector('button')).toBeNull();
    });

    it('renders the editor for EMPTY tags while editing (the primary tagging case)', () => {
      const { container } = render(
        <ResourceTagsInline {...defaultProps} tags={[]} isEditing={true} vocabulary={['Person']} />,
      );
      // No null short-circuit in edit mode: the strip renders with an add affordance.
      expect(container.firstChild).not.toBeNull();
      expect(screen.getByLabelText('Add tag')).toBeInTheDocument();
    });

    it('removing a tag commits ONCE with the full new set', async () => {
      render(<ResourceTagsInline {...defaultProps} isEditing={true} />);
      fireEvent.click(screen.getByLabelText('Remove tag2'));
      await waitFor(() => expect(mockOnUpdate).toHaveBeenCalledTimes(1));
      expect(mockOnUpdate).toHaveBeenCalledWith(['tag1', 'tag3']);
    });

    it('disabled renders the editor inert', () => {
      render(
        <ResourceTagsInline {...defaultProps} isEditing={true} disabled={true} vocabulary={['Person']} />,
      );
      fireEvent.click(screen.getByLabelText('Remove tag1'));
      expect(mockOnUpdate).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Remove tag1')).toBeDisabled();
      expect(screen.getByLabelText('Add tag')).toBeDisabled();
    });

    it('an in-flight onUpdate blocks a second commit', async () => {
      let resolveUpdate!: () => void;
      mockOnUpdate.mockImplementation(() => new Promise<void>((r) => { resolveUpdate = r; }));
      render(<ResourceTagsInline {...defaultProps} isEditing={true} />);

      fireEvent.click(screen.getByLabelText('Remove tag1'));
      fireEvent.click(screen.getByLabelText('Remove tag2')); // while pending — must not fire
      expect(mockOnUpdate).toHaveBeenCalledTimes(1);

      resolveUpdate();
      await waitFor(() => expect(screen.getByLabelText('Remove tag2')).not.toBeDisabled());
      fireEvent.click(screen.getByLabelText('Remove tag2')); // settled — fires again
      expect(mockOnUpdate).toHaveBeenCalledTimes(2);
    });
  });

  describe('Vocabulary (controlled — adds are a picker, never free text)', () => {
    it('the add affordance offers ONLY vocabulary entries minus already-applied tags', () => {
      render(
        <ResourceTagsInline {...defaultProps} tags={['Person']} isEditing={true}
          vocabulary={['Person', 'Place', 'Topic']} />,
      );
      fireEvent.click(screen.getByLabelText('Add tag'));
      expect(screen.getByRole('button', { name: 'Place' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Topic' })).toBeInTheDocument();
      // Already applied → not a candidate (the chip renders as text, not a candidate button)
      expect(screen.queryByRole('button', { name: 'Person' })).not.toBeInTheDocument();
    });

    it('picking a candidate commits the full set including the added tag', async () => {
      render(
        <ResourceTagsInline {...defaultProps} tags={['Person']} isEditing={true}
          vocabulary={['Person', 'Place']} />,
      );
      fireEvent.click(screen.getByLabelText('Add tag'));
      fireEvent.click(screen.getByRole('button', { name: 'Place' }));
      await waitFor(() => expect(mockOnUpdate).toHaveBeenCalledTimes(1));
      expect(mockOnUpdate).toHaveBeenCalledWith(['Person', 'Place']);
    });

    it('without a vocabulary the editor is REMOVAL-ONLY (no add affordance)', () => {
      render(<ResourceTagsInline {...defaultProps} isEditing={true} />);
      expect(screen.queryByLabelText('Add tag')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Remove tag1')).toBeInTheDocument();
    });

    it('removal is never vocabulary-gated — a stale tag not in the vocabulary is removable', async () => {
      render(
        <ResourceTagsInline {...defaultProps} tags={['LegacyType', 'Person']} isEditing={true}
          vocabulary={['Person']} />,
      );
      fireEvent.click(screen.getByLabelText('Remove LegacyType'));
      await waitFor(() => expect(mockOnUpdate).toHaveBeenCalledTimes(1));
      expect(mockOnUpdate).toHaveBeenCalledWith(['Person']);
    });
  });
});
