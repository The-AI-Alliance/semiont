import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils';
import '@testing-library/jest-dom';
import { ResourceSearchModal } from '../ResourceSearchModal';

// Mock HeadlessUI to avoid jsdom OOM issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, onClose, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

// Mock api-hooks
const mockUseQuery = vi.fn(() => ({
  data: null,
  isFetching: false,
}));

vi.mock('../../../lib/api-hooks', () => ({
  useResources: vi.fn(() => ({
    search: {
      useQuery: mockUseQuery,
    },
  })),
}));

// Mock search announcements
vi.mock('../../../hooks/useSearchAnnouncements', () => ({
  useSearchAnnouncements: vi.fn(() => ({
    announceSearchResults: vi.fn(),
    announceSearching: vi.fn(),
    announceNavigation: vi.fn(),
  })),
}));

describe('ResourceSearchModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: null, isFetching: false });
  });

  it('renders modal with title when open', () => {
    renderWithProviders(<ResourceSearchModal {...defaultProps} />);
    expect(screen.getByText('Search Resources')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderWithProviders(
      <ResourceSearchModal {...defaultProps} isOpen={false} />
    );
    expect(screen.queryByText('Search Resources')).not.toBeInTheDocument();
  });

  it('renders search input with placeholder', () => {
    renderWithProviders(<ResourceSearchModal {...defaultProps} />);
    expect(screen.getByPlaceholderText('Search for resources...')).toBeInTheDocument();
  });

  it('uses custom translations', () => {
    renderWithProviders(
      <ResourceSearchModal
        {...defaultProps}
        translations={{ title: 'Find Docs', placeholder: 'Type here...' }}
      />
    );
    expect(screen.getByText('Find Docs')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type here...')).toBeInTheDocument();
  });

  it('shows loading state when fetching', () => {
    mockUseQuery.mockReturnValue({ data: null, isFetching: true });
    renderWithProviders(<ResourceSearchModal {...defaultProps} />);
    expect(screen.getByText('Searching...')).toBeInTheDocument();
  });

  it('shows no results message when search has no matches', () => {
    mockUseQuery.mockReturnValue({
      data: { resources: [] },
      isFetching: false,
    });

    renderWithProviders(
      <ResourceSearchModal {...defaultProps} searchTerm="xyz" />
    );
    expect(screen.getByText('No documents found')).toBeInTheDocument();
  });

  it('renders search results', () => {
    mockUseQuery.mockReturnValue({
      data: {
        resources: [
          {
            '@id': 'res-1',
            name: 'Test Document',
            content: 'Some content here',
            representations: [{ mediaType: 'text/plain' }],
          },
        ],
      },
      isFetching: false,
    });

    renderWithProviders(
      <ResourceSearchModal {...defaultProps} searchTerm="test" />
    );
    expect(screen.getByText('Test Document')).toBeInTheDocument();
  });

  it('calls onSelect and onClose when a result is clicked', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    mockUseQuery.mockReturnValue({
      data: {
        resources: [
          {
            '@id': 'res-1',
            name: 'Test Document',
            content: 'Some content',
            representations: [{ mediaType: 'text/plain' }],
          },
        ],
      },
      isFetching: false,
    });

    renderWithProviders(
      <ResourceSearchModal
        {...defaultProps}
        searchTerm="test"
        onSelect={onSelect}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText('Test Document'));
    expect(onSelect).toHaveBeenCalledWith('res-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows media type for image results', () => {
    mockUseQuery.mockReturnValue({
      data: {
        resources: [
          {
            '@id': 'res-img',
            name: 'Photo',
            content: 'image data',
            representations: [{ mediaType: 'image/png' }],
          },
        ],
      },
      isFetching: false,
    });

    renderWithProviders(
      <ResourceSearchModal {...defaultProps} searchTerm="photo" />
    );
    expect(screen.getByText('image/png')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ResourceSearchModal {...defaultProps} onClose={onClose} />
    );
    fireEvent.click(screen.getByLabelText('✕'));
    expect(onClose).toHaveBeenCalled();
  });
});
