import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResourceTagsInline } from '../ResourceTagsInline';

describe('ResourceTagsInline', () => {
  const mockOnUpdate = vi.fn();
  const defaultProps = {
    documentId: 'doc-123',
    tags: ['tag1', 'tag2', 'tag3'],
    isEditing: false,
    onUpdate: mockOnUpdate,
  };

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

    it('should work with different documentId values', () => {
      const { rerender } = render(<ResourceTagsInline {...defaultProps} />);

      expect(screen.getByText('tag1')).toBeInTheDocument();

      rerender(<ResourceTagsInline {...defaultProps} documentId="doc-456" />);

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
});
