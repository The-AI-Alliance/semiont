/**
 * SearchModal Component Tests - Basic Rendering
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

describe('SearchModal Component - Basic Rendering', () => {
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
});
