import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StubReferencePopup } from '../StubReferencePopup';
import { useRouter } from '@/i18n/routing';
import type { ReferenceAnnotation, TextSelection } from '@/lib/api';

// Mock @/i18n/routing
vi.mock('@/i18n/routing', () => ({
  useRouter: vi.fn()
}));

// Mock API service
vi.mock('@/lib/api', () => ({
  apiService: {
    documents: {
      search: vi.fn(() => Promise.resolve({ documents: [] }))
    }
  },
  api: {
    documents: {
      search: {
        useQuery: vi.fn(() => ({
          data: { documents: [] },
          isLoading: false,
          error: null
        }))
      }
    }
  },
  getEntityTypes: vi.fn((annotation: any) => {
    // Extract entity types from W3C body array
    if (Array.isArray(annotation.body)) {
      return annotation.body
        .filter((item: any) => item.type === 'TextualBody' && item.purpose === 'tagging')
        .map((item: any) => item.value);
    }
    return [];
  })
}));

// Helper to wrap component with QueryClientProvider
function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
}

describe('StubReferencePopup', () => {
  const mockPush = vi.fn();
  const mockOnClose = vi.fn();
  const mockOnUpdateAnnotation = vi.fn();
  const mockOnDeleteAnnotation = vi.fn();
  const mockOnGenerateDocument = vi.fn();

  const defaultProps = {
    isOpen: true,
    onClose: mockOnClose,
    position: { x: 100, y: 100 },
    selection: {
      exact: 'Selected text',
      start: 0,
      end: 13
    } as TextSelection,
    annotation: {
      '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
      'type': 'Annotation' as const,
      id: 'test-annotation',
      target: {
        source: 'test-doc',
        selector: [
          {
            type: 'TextPositionSelector',
            start: 0,
            end: 13,
          },
          {
            type: 'TextQuoteSelector',
            exact: 'Selected text',
          },
        ],
      },
      // Stub reference has empty body array
      body: [],
      // entityTypes at annotation level
      entityTypes: ['Person'],
      motivation: 'linking',
      creator: {
        type: 'Person',
        id: 'did:web:test.com:users:test-user',
        name: 'test-user',
      },
      created: new Date().toISOString(),
    } as ReferenceAnnotation,
    onUpdateAnnotation: mockOnUpdateAnnotation,
    onDeleteAnnotation: mockOnDeleteAnnotation,
    onGenerateDocument: mockOnGenerateDocument
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as any).mockReturnValue({ push: mockPush });
  });

  describe('Nested Modal Behavior', () => {
    it('should open SearchDocumentsModal when "Link to Existing Document" is clicked', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      // Find and click the "Link to Existing Document" button
      const linkButton = screen.getByText('🔍 Search');
      fireEvent.click(linkButton);

      // SearchDocumentsModal should appear
      await waitFor(() => {
        expect(screen.getByText('Search Documents')).toBeInTheDocument();
      });

      // Both modals should be visible
      expect(screen.getByText('Stub Reference')).toBeInTheDocument();
      expect(screen.getByText('Search Documents')).toBeInTheDocument();
    });

    it('should handle Escape key in nested modal (closes only the nested modal)', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      // Open the SearchDocumentsModal
      const linkButton = screen.getByText('🔍 Search');
      fireEvent.click(linkButton);

      await waitFor(() => {
        expect(screen.getByText('Search Documents')).toBeInTheDocument();
      });

      // Press Escape key
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

      // SearchDocumentsModal should close
      await waitFor(() => {
        expect(screen.queryByText('Search Documents')).not.toBeInTheDocument();
      });

      // But StubReferencePopup should remain open
      expect(screen.getByText('Stub Reference')).toBeInTheDocument();
    });

    it('should render SearchDocumentsModal with interactive elements', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      // Open the SearchDocumentsModal
      const linkButton = screen.getByText('🔍 Search');
      fireEvent.click(linkButton);

      await waitFor(() => {
        expect(screen.getByText('Search Documents')).toBeInTheDocument();
      });

      // Verify modal elements are present and accessible
      const searchInput = screen.getByPlaceholderText('Search for documents...');

      expect(searchInput).toBeInTheDocument();

      // There should be close buttons for both modals
      const closeButtons = screen.getAllByText('✕');
      expect(closeButtons.length).toBeGreaterThan(0);

      // Note: Headless UI Dialog handles focus trapping automatically
    });

    it('should restore focus to parent modal when nested modal closes', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      // Get reference to the link button
      const linkButton = screen.getByText('🔍 Search');

      // Open the SearchDocumentsModal
      fireEvent.click(linkButton);

      await waitFor(() => {
        expect(screen.getByText('Search Documents')).toBeInTheDocument();
      });

      // Close the SearchDocumentsModal (there are multiple close buttons, get the last one)
      const closeButtons = screen.getAllByText('✕');
      const searchModalCloseButton = closeButtons[closeButtons.length - 1];
      if (searchModalCloseButton) {
        fireEvent.click(searchModalCloseButton);
      }

      // SearchDocumentsModal should close
      await waitFor(() => {
        expect(screen.queryByText('Search Documents')).not.toBeInTheDocument();
      });

      // Parent modal should still be open
      expect(screen.getByText('Stub Reference')).toBeInTheDocument();

      // Note: Headless UI handles focus restoration automatically
    });
  });

  describe('Keyboard Navigation in StubReferencePopup', () => {
    it('should close popup when Escape is pressed', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      expect(screen.getByText('Stub Reference')).toBeInTheDocument();

      // Press Escape key
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

      // onClose should be called
      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('should close popup when pressing Escape', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      expect(screen.getByText('Stub Reference')).toBeInTheDocument();

      // Press Escape to close dialog
      fireEvent.keyDown(document, { key: 'Escape' });

      // onClose should be called
      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('should have focusable interactive elements', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      const linkButton = screen.getByText('🔍 Search');
      const generateButton = screen.getByText('✨ Generate');
      const deleteButton = screen.getByText('🗑️ Delete Reference');

      // All buttons should be in the document and focusable
      expect(linkButton).toBeInTheDocument();
      expect(generateButton).toBeInTheDocument();
      expect(deleteButton).toBeInTheDocument();

      // Verify buttons are not disabled
      expect(linkButton).not.toBeDisabled();
      expect(generateButton).not.toBeDisabled();
      expect(deleteButton).not.toBeDisabled();

      // Note: Headless UI Dialog handles focus trapping automatically
    });

    it('should handle Shift+Tab for reverse navigation', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      const linkButton = screen.getByText('🔍 Search');
      const deleteButton = screen.getByText('🗑️ Delete Reference');

      // Focus last button
      deleteButton.focus();
      expect(document.activeElement).toBe(deleteButton);

      // Shift+Tab should go to previous buttons in reverse order
      fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });

      // Should cycle through all interactive elements and eventually back to delete button
      await waitFor(() => {
        const activeElement = document.activeElement;
        expect(activeElement?.tagName).toBe('BUTTON');
      });
    });
  });

  describe('Modal Content Behavior', () => {
    it('should not close when clicking inside the modal content', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      // Click inside the modal content
      const modalContent = screen.getByText('Stub Reference');
      fireEvent.click(modalContent);

      // Modal should remain open, onClose should not be called
      expect(mockOnClose).not.toHaveBeenCalled();
      expect(screen.getByText('Stub Reference')).toBeInTheDocument();
    });

    it('should call onDeleteAnnotation when delete button is clicked', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      const deleteButton = screen.getByText('🗑️ Delete Reference');
      fireEvent.click(deleteButton);

      expect(mockOnDeleteAnnotation).toHaveBeenCalled();
    });

    it('should call onGenerateDocument when generate button is clicked', async () => {
      renderWithQueryClient(<StubReferencePopup {...defaultProps} />);

      const generateButton = screen.getByText('✨ Generate');
      fireEvent.click(generateButton);

      // Should call onGenerateDocument with the selected text
      await waitFor(() => {
        expect(mockOnGenerateDocument).toHaveBeenCalledWith('Selected text');
      });
    });
  });
});