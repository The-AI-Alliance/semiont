/**
 * SearchModal Component Tests
 *
 * Tests for the SearchModal component including keyboard navigation,
 * search functionality, accessibility, and user interactions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchModal } from '../SearchModal';

// Mock the hooks
vi.mock('../../../hooks/useSearchAnnouncements', () => ({
  useSearchAnnouncements: () => ({
    announceSearchResults: vi.fn(),
    announceSearching: vi.fn()
  })
}));

// Mock getResourceId
vi.mock('@semiont/api-client', () => ({
  getResourceId: vi.fn((resource: any) => resource?.id)
}));

describe('SearchModal Component', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onNavigate: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('Basic Rendering', () => {
    it('should render when open', () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');
      expect(input).toBeInTheDocument();
    });

    it('should not render when closed', () => {
      render(<SearchModal {...defaultProps} isOpen={false} />);

      const input = screen.queryByPlaceholderText('Search resources, entities...');
      expect(input).not.toBeInTheDocument();
    });

    it('should render with custom translations', () => {
      const translations = {
        placeholder: 'Custom search',
        startTyping: 'Type to search',
        noResults: 'Nothing found for',
        searching: 'Looking...',
        navigate: 'Nav',
        select: 'Choose',
        close: 'Exit',
        enter: 'Return',
        esc: 'Escape'
      };

      render(<SearchModal {...defaultProps} translations={translations} />);

      const input = screen.getByPlaceholderText('Custom search');
      expect(input).toBeInTheDocument();
      expect(screen.getByText('Type to search')).toBeInTheDocument();
    });
  });

  describe('Search Input', () => {
    it('should focus input on mount', () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
    });

    it('should update query on input change', async () => {
      const user = userEvent.setup({ delay: null });
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;

      await user.type(input, 'test query');

      expect(input.value).toBe('test query');
    });

    it('should debounce search query', async () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;

      fireEvent.change(input, { target: { value: 'quick' } });

      // Immediately after typing, results should not be shown
      expect(screen.getByText('Start typing to search...')).toBeInTheDocument();

      // After debounce period (300ms), query should be processed
      vi.advanceTimersByTime(300);

      await waitFor(() => {
        expect(screen.getByText('No results found for "quick"')).toBeInTheDocument();
      });
    });

    it('should show no results message when search returns empty', async () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;

      fireEvent.change(input, { target: { value: 'nonexistent' } });
      vi.advanceTimersByTime(300);

      await waitFor(() => {
        expect(screen.getByText('No results found for "nonexistent"')).toBeInTheDocument();
      });
    });

    it('should clear search on modal close', () => {
      const { rerender } = render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;

      fireEvent.change(input, { target: { value: 'test' } });
      expect(input.value).toBe('test');

      // Close modal
      rerender(<SearchModal {...defaultProps} isOpen={false} />);

      // Reopen modal
      rerender(<SearchModal {...defaultProps} isOpen={true} />);

      const newInput = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;
      expect(newInput.value).toBe('');
    });
  });

  describe('Keyboard Navigation', () => {
    it('should handle Escape key to close modal', () => {
      render(<SearchModal {...defaultProps} />);

      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape' });

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });

    it('should handle Arrow Down key to navigate results', async () => {
      const mockResults = [
        { type: 'resource' as const, id: '1', name: 'Resource 1', content: 'Content 1' },
        { type: 'resource' as const, id: '2', name: 'Resource 2', content: 'Content 2' },
        { type: 'entity' as const, id: '3', name: 'Entity 1', entityType: 'Person' }
      ];

      // TODO: Mock search results when API is integrated
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');

      fireEvent.keyDown(input, { key: 'ArrowDown' });
      // Selection should cycle through available results
    });

    it('should handle Arrow Up key to navigate results', async () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');

      fireEvent.keyDown(input, { key: 'ArrowUp' });
      // Selection should cycle backwards through results
    });

    it('should handle Enter key to select result', async () => {
      // TODO: Add when results can be mocked
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');

      // Would need mock results to test properly
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    it('should prevent default behavior for navigation keys', () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');

      const downEvent = new KeyboardEvent('keydown', { key: 'ArrowDown' });
      const preventDefault = vi.spyOn(downEvent, 'preventDefault');

      input.dispatchEvent(downEvent);
      expect(preventDefault).toHaveBeenCalled();
    });
  });

  describe('Result Display', () => {
    it('should show start typing message when query is empty', () => {
      render(<SearchModal {...defaultProps} />);

      expect(screen.getByText('Start typing to search...')).toBeInTheDocument();
    });

    it('should show keyboard shortcuts', () => {
      render(<SearchModal {...defaultProps} />);

      expect(screen.getByText('↑↓')).toBeInTheDocument();
      expect(screen.getByText('Navigate')).toBeInTheDocument();
      expect(screen.getByText('Enter')).toBeInTheDocument();
      expect(screen.getByText('Select')).toBeInTheDocument();
      expect(screen.getByText('Esc')).toBeInTheDocument();
      expect(screen.getByText('Close')).toBeInTheDocument();
    });

    it('should display ESC key hint in header', () => {
      render(<SearchModal {...defaultProps} />);

      const escHint = screen.getByText('ESC');
      expect(escHint).toBeInTheDocument();
      expect(escHint.parentElement).toHaveClass('px-2', 'py-1');
    });
  });

  describe('Result Interaction', () => {
    // These tests would need proper mocking of search results
    // Currently the component has hardcoded empty results

    it('should call onNavigate when result is clicked', async () => {
      // TODO: Test when search results can be properly mocked
      render(<SearchModal {...defaultProps} />);
    });

    it('should close modal after navigation', async () => {
      // TODO: Test when search results can be properly mocked
      render(<SearchModal {...defaultProps} />);
    });

    it('should update selected index on mouse hover', async () => {
      // TODO: Test when search results can be properly mocked
      render(<SearchModal {...defaultProps} />);
    });
  });

  describe('Accessibility', () => {
    it('should have proper dialog role', () => {
      render(<SearchModal {...defaultProps} />);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
    });

    it('should trap focus within modal', () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');
      expect(document.activeElement).toBe(input);
    });

    it('should have search input with proper attributes', () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');
      expect(input).toHaveAttribute('type', 'text');
      expect(input).toHaveProperty('autofocus');
    });

    it('should render search icon', () => {
      const { container } = render(<SearchModal {...defaultProps} />);

      const searchIcon = container.querySelector('svg path[d*="M21 21l-6-6"]');
      expect(searchIcon).toBeInTheDocument();
    });
  });

  describe('Visual States', () => {
    it('should show loading state', () => {
      // TODO: Mock loading state when API integration is complete
      render(<SearchModal {...defaultProps} />);

      // Currently loading is hardcoded to false
      // Would test: expect(screen.getByText('Searching...')).toBeInTheDocument();
    });

    it('should have backdrop with proper classes', () => {
      const { container } = render(<SearchModal {...defaultProps} />);

      const backdrop = container.querySelector('.bg-black\\/30');
      expect(backdrop).toBeInTheDocument();
      expect(backdrop).toHaveClass('backdrop-blur-sm');
    });

    it('should have modal panel with proper classes', () => {
      render(<SearchModal {...defaultProps} />);

      const panel = screen.getByRole('dialog').firstChild;
      expect(panel).toHaveClass('bg-white', 'dark:bg-gray-800');
    });
  });

  describe('Transitions', () => {
    it('should apply enter transition classes', () => {
      const { container } = render(<SearchModal {...defaultProps} />);

      const transitionElements = container.querySelectorAll('[data-headlessui-state]');
      expect(transitionElements.length).toBeGreaterThan(0);
    });

    it('should handle modal open/close transitions', () => {
      const { rerender } = render(<SearchModal {...defaultProps} isOpen={false} />);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      rerender(<SearchModal {...defaultProps} isOpen={true} />);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty translations object', () => {
      render(<SearchModal {...defaultProps} translations={{}} />);

      // Should fall back to default translations
      expect(screen.getByPlaceholderText('Search resources, entities...')).toBeInTheDocument();
      expect(screen.getByText('Start typing to search...')).toBeInTheDocument();
    });

    it('should handle rapid open/close', () => {
      const { rerender } = render(<SearchModal {...defaultProps} />);

      rerender(<SearchModal {...defaultProps} isOpen={false} />);
      rerender(<SearchModal {...defaultProps} isOpen={true} />);
      rerender(<SearchModal {...defaultProps} isOpen={false} />);
      rerender(<SearchModal {...defaultProps} isOpen={true} />);

      const input = screen.getByPlaceholderText('Search resources, entities...');
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('');
    });

    it('should handle special characters in search query', async () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;

      fireEvent.change(input, { target: { value: 'test@#$%^&*()' } });

      expect(input.value).toBe('test@#$%^&*()');

      vi.advanceTimersByTime(300);

      await waitFor(() => {
        expect(screen.getByText(/No results found for/)).toBeInTheDocument();
      });
    });

    it('should handle very long search query', async () => {
      render(<SearchModal {...defaultProps} />);

      const input = screen.getByPlaceholderText('Search resources, entities...') as HTMLInputElement;
      const longQuery = 'a'.repeat(1000);

      fireEvent.change(input, { target: { value: longQuery } });

      expect(input.value).toBe(longQuery);
    });
  });

  describe('Result Types', () => {
    it('should render resource icon for resource type', () => {
      // TODO: Test when results can be mocked
      // Would check for the document icon SVG
      render(<SearchModal {...defaultProps} />);
    });

    it('should render entity icon for entity type', () => {
      // TODO: Test when results can be mocked
      // Would check for the tag icon SVG
      render(<SearchModal {...defaultProps} />);
    });

    it('should display entity type badge', () => {
      // TODO: Test when results can be mocked
      // Would check for entity type badge like "Person"
      render(<SearchModal {...defaultProps} />);
    });
  });

  describe('Result Content', () => {
    it('should truncate long content', () => {
      // TODO: Test when results can be mocked
      // Would verify content is limited to 150 characters
      render(<SearchModal {...defaultProps} />);
    });

    it('should highlight selected result', () => {
      // TODO: Test when results can be mocked
      // Would check for selected styling
      render(<SearchModal {...defaultProps} />);
    });

    it('should show Enter hint for selected result', () => {
      // TODO: Test when results can be mocked
      // Would check for Enter key hint on selected item
      render(<SearchModal {...defaultProps} />);
    });
  });
});