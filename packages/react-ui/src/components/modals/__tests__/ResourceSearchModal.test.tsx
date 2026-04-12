import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
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

// Mock the api-client Observable surface
const browseResourcesSubject = new BehaviorSubject<any[] | undefined>(undefined);
const browseResourcesMock = vi.fn(() => browseResourcesSubject.asObservable());

vi.mock('../../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/ApiClientContext')>(
    '../../../contexts/ApiClientContext'
  );
  return {
    ...actual,
    useApiClient: () => ({
      browse: { resources: browseResourcesMock },
    }),
  };
});

// Mock search announcements
vi.mock('../../../hooks/useSearchAnnouncements', () => ({
  useSearchAnnouncements: vi.fn(() => ({
    announceSearchResults: vi.fn(),
    announceSearching: vi.fn(),
    announceNavigation: vi.fn(),
  })),
}));

function setBrowseResults(resources: any[] | undefined) {
  browseResourcesSubject.next(resources);
}

describe('ResourceSearchModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    browseResourcesSubject.next(undefined);
  });

  const buildResource = (id: string, name: string, mediaType = 'text/plain', content?: string) => ({
    '@context': 'https://www.w3.org/ns/anno.jsonld',
    '@id': id,
    name,
    content,
    representations: [{ mediaType, isPrimary: true }],
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

  it('shows loading state while the Observable has not emitted', async () => {
    renderWithProviders(<ResourceSearchModal {...defaultProps} searchTerm="something" />);
    await waitFor(() => expect(screen.getByText('Searching...')).toBeInTheDocument(), { timeout: 1000 });
  });

  it('shows no results message when search returns an empty array', async () => {
    renderWithProviders(<ResourceSearchModal {...defaultProps} searchTerm="xyz" />);
    setBrowseResults([]);
    await waitFor(() => expect(screen.getByText('No documents found')).toBeInTheDocument(), { timeout: 1000 });
  });

  it('renders search results', async () => {
    renderWithProviders(<ResourceSearchModal {...defaultProps} searchTerm="test" />);
    setBrowseResults([buildResource('res-1', 'Test Document', 'text/plain', 'Some content here')]);
    await waitFor(() => expect(screen.getByText('Test Document')).toBeInTheDocument(), { timeout: 1000 });
  });

  it('calls onSelect and onClose when a result is clicked', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    renderWithProviders(
      <ResourceSearchModal
        {...defaultProps}
        searchTerm="test"
        onSelect={onSelect}
        onClose={onClose}
      />
    );
    setBrowseResults([buildResource('res-1', 'Test Document', 'text/plain', 'Some content')]);
    await waitFor(() => expect(screen.getByText('Test Document')).toBeInTheDocument(), { timeout: 1000 });

    fireEvent.click(screen.getByText('Test Document'));
    expect(onSelect).toHaveBeenCalledWith('res-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows media type for image results', async () => {
    renderWithProviders(<ResourceSearchModal {...defaultProps} searchTerm="photo" />);
    setBrowseResults([buildResource('res-img', 'Photo', 'image/png')]);
    await waitFor(() => expect(screen.getByText('image/png')).toBeInTheDocument(), { timeout: 1000 });
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ResourceSearchModal {...defaultProps} onClose={onClose} />
    );
    fireEvent.click(screen.getByLabelText('✕'));
    expect(onClose).toHaveBeenCalled();
  });

  it('passes the search term through to browse.resources', async () => {
    renderWithProviders(<ResourceSearchModal {...defaultProps} searchTerm="hello" />);
    await waitFor(
      () => expect(browseResourcesMock).toHaveBeenCalledWith({ search: 'hello', limit: 50 }),
      { timeout: 1000 }
    );
  });
});
