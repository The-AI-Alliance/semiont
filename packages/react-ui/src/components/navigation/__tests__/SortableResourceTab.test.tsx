import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../test-utils';
import type { SortableResourceTabProps } from '../../../types/collapsible-navigation';

// Mock @dnd-kit/sortable
const mockSetNodeRef = vi.fn();
const mockSortableReturn = {
  attributes: { role: 'button', tabIndex: 0 },
  listeners: {},
  setNodeRef: mockSetNodeRef,
  transform: null,
  transition: null,
  isDragging: false,
};

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: vi.fn(() => mockSortableReturn),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: vi.fn((transform: any) => (transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined)),
    },
  },
}));

vi.mock('../../../lib/resource-utils', () => ({
  getResourceIcon: vi.fn((mediaType: string | undefined) => {
    if (!mediaType) return '\u{1F4C4}';
    if (mediaType.startsWith('image/')) return '\u{1F5BC}\uFE0F';
    if (mediaType === 'text/markdown') return '\u{1F4DD}';
    return '\u{1F4C4}';
  }),
}));

import { useSortable } from '@dnd-kit/sortable';
import { SortableResourceTab } from '../SortableResourceTab';

describe('SortableResourceTab', () => {
  const MockLink = ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  );

  const defaultProps: SortableResourceTabProps = {
    resource: {
      id: 'resource-1',
      name: 'Test Document',
      openedAt: Date.now(),
      mediaType: 'text/plain',
    },
    isCollapsed: false,
    isActive: false,
    href: '/resources/resource-1',
    onClose: vi.fn(),
    LinkComponent: MockLink,
    translations: {},
    index: 0,
    totalCount: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSortable).mockReturnValue(mockSortableReturn as any);
  });

  describe('Rendering', () => {
    it('should render the resource name', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      expect(screen.getByText('Test Document')).toBeInTheDocument();
    });

    it('should render the resource icon', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      const icon = screen.getByText('\u{1F4C4}');
      expect(icon).toBeInTheDocument();
    });

    it('should render link with correct href', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      const link = screen.getByTitle('Test Document');
      expect(link).toHaveAttribute('href', '/resources/resource-1');
    });

    it('should render close button when not collapsed', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      const closeButton = screen.getByLabelText('Close Test Document');
      expect(closeButton).toBeInTheDocument();
    });

    it('should not render close button when collapsed', () => {
      renderWithProviders(
        <SortableResourceTab {...defaultProps} isCollapsed={true} />
      );

      expect(screen.queryByLabelText('Close Test Document')).not.toBeInTheDocument();
    });

    it('should not render resource name text when collapsed', () => {
      renderWithProviders(
        <SortableResourceTab {...defaultProps} isCollapsed={true} />
      );

      expect(screen.queryByText('Test Document')).not.toBeInTheDocument();
    });

    it('should render icon when collapsed', () => {
      renderWithProviders(
        <SortableResourceTab {...defaultProps} isCollapsed={true} />
      );

      expect(screen.getByText('\u{1F4C4}')).toBeInTheDocument();
    });
  });

  describe('Active state', () => {
    it('should have active class when isActive is true', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} isActive={true} />
      );

      const tab = container.querySelector('.semiont-resource-tab');
      expect(tab).toHaveClass('semiont-resource-tab--active');
    });

    it('should not have active class when isActive is false', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} isActive={false} />
      );

      const tab = container.querySelector('.semiont-resource-tab');
      expect(tab).not.toHaveClass('semiont-resource-tab--active');
    });

    it('should set aria-selected based on isActive', () => {
      renderWithProviders(
        <SortableResourceTab {...defaultProps} isActive={true} />
      );

      const tab = screen.getByRole('tab');
      expect(tab).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('Dragging state', () => {
    it('should have dragging class when isDragging prop is true', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} isDragging={true} />
      );

      const tab = container.querySelector('.semiont-resource-tab');
      expect(tab).toHaveClass('semiont-resource-tab--dragging');
    });

    it('should have dragging class when useSortable reports dragging', () => {
      vi.mocked(useSortable).mockReturnValue({
        ...mockSortableReturn,
        isDragging: true,
      } as any);

      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} />
      );

      const tab = container.querySelector('.semiont-resource-tab');
      expect(tab).toHaveClass('semiont-resource-tab--dragging');
    });

    it('should not have dragging class when not dragging', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} isDragging={false} />
      );

      const tab = container.querySelector('.semiont-resource-tab');
      expect(tab).not.toHaveClass('semiont-resource-tab--dragging');
    });
  });

  describe('Close button', () => {
    it('should call onClose with resource id and event when clicked', () => {
      const onClose = vi.fn();
      renderWithProviders(
        <SortableResourceTab {...defaultProps} onClose={onClose} />
      );

      const closeButton = screen.getByLabelText('Close Test Document');
      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledWith('resource-1', expect.any(Object));
    });

    it('should use custom translation for close button title', () => {
      renderWithProviders(
        <SortableResourceTab
          {...defaultProps}
          translations={{ closeResource: 'Fermer la ressource' }}
        />
      );

      const closeButton = screen.getByTitle('Fermer la ressource');
      expect(closeButton).toBeInTheDocument();
    });

    it('should default to "Close resource" title', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      const closeButton = screen.getByTitle('Close resource');
      expect(closeButton).toBeInTheDocument();
    });
  });

  describe('Keyboard reordering', () => {
    it('should call onReorder with "up" on Alt+ArrowUp', () => {
      const onReorder = vi.fn();
      renderWithProviders(
        <SortableResourceTab {...defaultProps} onReorder={onReorder} />
      );

      const tab = screen.getByRole('tab');
      fireEvent.keyDown(tab, { key: 'ArrowUp', altKey: true });

      expect(onReorder).toHaveBeenCalledWith('resource-1', 'up');
    });

    it('should call onReorder with "down" on Alt+ArrowDown', () => {
      const onReorder = vi.fn();
      renderWithProviders(
        <SortableResourceTab {...defaultProps} onReorder={onReorder} />
      );

      const tab = screen.getByRole('tab');
      fireEvent.keyDown(tab, { key: 'ArrowDown', altKey: true });

      expect(onReorder).toHaveBeenCalledWith('resource-1', 'down');
    });

    it('should not call onReorder without Alt key', () => {
      const onReorder = vi.fn();
      renderWithProviders(
        <SortableResourceTab {...defaultProps} onReorder={onReorder} />
      );

      const tab = screen.getByRole('tab');
      fireEvent.keyDown(tab, { key: 'ArrowUp' });

      expect(onReorder).not.toHaveBeenCalled();
    });

    it('should not call onReorder for non-arrow keys with Alt', () => {
      const onReorder = vi.fn();
      renderWithProviders(
        <SortableResourceTab {...defaultProps} onReorder={onReorder} />
      );

      const tab = screen.getByRole('tab');
      fireEvent.keyDown(tab, { key: 'Enter', altKey: true });

      expect(onReorder).not.toHaveBeenCalled();
    });

    it('should not error when onReorder is not provided', () => {
      renderWithProviders(
        <SortableResourceTab {...defaultProps} onReorder={undefined} />
      );

      const tab = screen.getByRole('tab');
      expect(() => {
        fireEvent.keyDown(tab, { key: 'ArrowUp', altKey: true });
      }).not.toThrow();
    });
  });

  describe('Accessibility', () => {
    it('should have tab role', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      expect(screen.getByRole('tab')).toBeInTheDocument();
    });

    it('should have aria-label with position info', () => {
      renderWithProviders(
        <SortableResourceTab {...defaultProps} index={1} totalCount={5} />
      );

      const tab = screen.getByRole('tab');
      expect(tab).toHaveAttribute('aria-label', 'Test Document, position 2 of 5');
    });

    it('should have aria-hidden on icon', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} />
      );

      const icon = container.querySelector('.semiont-resource-tab__icon');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    });

    it('should have close button with aria-label', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      const closeButton = screen.getByLabelText('Close Test Document');
      expect(closeButton).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should have base tab class', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} />
      );

      expect(container.querySelector('.semiont-resource-tab')).toBeInTheDocument();
    });

    it('should have proper link class', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} />
      );

      expect(container.querySelector('.semiont-resource-tab__link')).toBeInTheDocument();
    });

    it('should have proper icon class', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} />
      );

      expect(container.querySelector('.semiont-resource-tab__icon')).toBeInTheDocument();
    });

    it('should have proper text class', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} />
      );

      expect(container.querySelector('.semiont-resource-tab__text')).toBeInTheDocument();
    });

    it('should have proper close button class', () => {
      const { container } = renderWithProviders(
        <SortableResourceTab {...defaultProps} />
      );

      expect(container.querySelector('.semiont-resource-tab__close')).toBeInTheDocument();
    });
  });

  describe('useSortable integration', () => {
    it('should call useSortable with resource id', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      expect(useSortable).toHaveBeenCalledWith({ id: 'resource-1' });
    });

    it('should pass setNodeRef to container', () => {
      renderWithProviders(<SortableResourceTab {...defaultProps} />);

      expect(mockSetNodeRef).toHaveBeenCalled();
    });
  });
});
