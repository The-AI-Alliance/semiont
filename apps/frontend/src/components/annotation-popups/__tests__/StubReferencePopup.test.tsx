import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StubReferencePopup } from '../StubReferencePopup';
import { useRouter } from 'next/navigation';
import type { ReferenceAnnotation, TextSelection } from '@/types/annotation';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn()
}));

// Mock API service
vi.mock('@/lib/api-client', () => ({
  apiService: {
    documents: {
      search: vi.fn()
    }
  }
}));

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
      text: 'Selected text',
      start: 0,
      end: 13
    } as TextSelection,
    annotation: {
      id: 'test-annotation',
      type: 'reference',
      entityType: 'Person',
      referenceType: 'Mention',
      provisional: true
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
      render(<StubReferencePopup {...defaultProps} />);

      // Find and click the "Link to Existing Document" button
      const linkButton = screen.getByText('🔗 Link to Existing Document');
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
      render(<StubReferencePopup {...defaultProps} />);

      // Open the SearchDocumentsModal
      const linkButton = screen.getByText('🔗 Link to Existing Document');
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

    it('should handle focus trapping in nested modal', async () => {
      render(<StubReferencePopup {...defaultProps} />);

      // Open the SearchDocumentsModal
      const linkButton = screen.getByText('🔗 Link to Existing Document');
      fireEvent.click(linkButton);

      await waitFor(() => {
        expect(screen.getByText('Search Documents')).toBeInTheDocument();
      });

      // Focus should be trapped in the SearchDocumentsModal
      const searchInput = screen.getByPlaceholderText('Search for documents...');
      const closeButton = screen.getByText('✕');

      searchInput.focus();
      expect(document.activeElement).toBe(searchInput);

      // Tab should move to close button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(closeButton);
      });

      // Tab should cycle back to search input
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(searchInput);
      });
    });

    it('should restore focus to parent modal when nested modal closes', async () => {
      render(<StubReferencePopup {...defaultProps} />);

      // Get reference to the link button
      const linkButton = screen.getByText('🔗 Link to Existing Document');

      // Open the SearchDocumentsModal
      fireEvent.click(linkButton);

      await waitFor(() => {
        expect(screen.getByText('Search Documents')).toBeInTheDocument();
      });

      // Close the SearchDocumentsModal
      const closeButton = screen.getByText('✕');
      fireEvent.click(closeButton);

      // SearchDocumentsModal should close
      await waitFor(() => {
        expect(screen.queryByText('Search Documents')).not.toBeInTheDocument();
      });

      // Focus should return to the parent modal (StubReferencePopup)
      // and the parent modal should still be open
      expect(screen.getByText('Stub Reference')).toBeInTheDocument();

      // Focus should be within the parent modal
      const activeElement = document.activeElement;
      const parentModal = screen.getByText('Stub Reference').closest('[role="dialog"]');
      expect(parentModal).toContainElement(activeElement as HTMLElement);
    });
  });

  describe('Keyboard Navigation in StubReferencePopup', () => {
    it('should close popup when Escape is pressed', async () => {
      render(<StubReferencePopup {...defaultProps} />);

      expect(screen.getByText('Stub Reference')).toBeInTheDocument();

      // Press Escape key
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

      // onClose should be called
      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('should close popup when clicking outside', async () => {
      const { container } = render(<StubReferencePopup {...defaultProps} />);

      expect(screen.getByText('Stub Reference')).toBeInTheDocument();

      // Click on the backdrop
      const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/20');
      if (backdrop) {
        fireEvent.click(backdrop);
      }

      // onClose should be called
      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('should trap focus within the popup', async () => {
      render(<StubReferencePopup {...defaultProps} />);

      const linkButton = screen.getByText('🔗 Link to Existing Document');
      const generateButton = screen.getByText('✨ Generate Document');
      const deleteButton = screen.getByText('🗑️ Delete Reference');

      // Focus first button
      linkButton.focus();
      expect(document.activeElement).toBe(linkButton);

      // Tab to next button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(generateButton);
      });

      // Tab to delete button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(deleteButton);
      });

      // Tab should wrap back to first button
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
      await waitFor(() => {
        expect(document.activeElement).toBe(linkButton);
      });
    });

    it('should handle Shift+Tab for reverse navigation', async () => {
      render(<StubReferencePopup {...defaultProps} />);

      const linkButton = screen.getByText('🔗 Link to Existing Document');
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
      render(<StubReferencePopup {...defaultProps} />);

      // Click inside the modal content
      const modalContent = screen.getByText('Stub Reference');
      fireEvent.click(modalContent);

      // Modal should remain open, onClose should not be called
      expect(mockOnClose).not.toHaveBeenCalled();
      expect(screen.getByText('Stub Reference')).toBeInTheDocument();
    });

    it('should call onDeleteAnnotation when delete button is clicked', async () => {
      render(<StubReferencePopup {...defaultProps} />);

      const deleteButton = screen.getByText('🗑️ Delete Reference');
      fireEvent.click(deleteButton);

      expect(mockOnDeleteAnnotation).toHaveBeenCalled();
    });

    it('should show generate document dialog when generate button is clicked', async () => {
      render(<StubReferencePopup {...defaultProps} />);

      const generateButton = screen.getByText('✨ Generate Document');
      fireEvent.click(generateButton);

      // Should show the generate document form
      await waitFor(() => {
        expect(screen.getByText('Generate New Document')).toBeInTheDocument();
        expect(screen.getByPlaceholderText(/document title/i)).toBeInTheDocument();
      });
    });
  });
});