/**
 * SearchModal — wiring + UI tests
 *
 * Verifies that SearchModal correctly wires createSearchPipeline to
 * browse.resources, maps results to its SearchResult shape, and renders
 * each emission. Pure pipeline behavior (debounce, distinct, switchMap,
 * loading state) is covered by search-pipeline.test.ts and not duplicated
 * here.
 *
 * Mocks HeadlessUI to dodge the jsdom OOM that prevents the older
 * SearchModal.* test files from running.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import { renderWithProviders } from '../../../test-utils';
import '@testing-library/jest-dom';
import { SearchModal } from '../SearchModal';

// Mock HeadlessUI to avoid jsdom OOM issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, ...props }: any) => (
    <div role="dialog" {...props}>
      {typeof children === 'function' ? children({ open: true }) : children}
    </div>
  ),
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => (show ? <>{children}</> : null),
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

// Mock the api-client Observable surface
const browseResourcesSubject = new BehaviorSubject<any[] | undefined>(undefined);
const browseResourcesMock = vi.fn(() => browseResourcesSubject.asObservable());

// Stable client reference — useApiClient is called on every render, so a
// fresh object literal would invalidate useMemo deps and restart the RxJS
// pipeline on every keystroke. The real ApiClientProvider holds a single
// instance; the mock must do the same.
const stableMockClient = { browse: { resources: browseResourcesMock } };

vi.mock('../../../contexts/ApiClientContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/ApiClientContext')>(
    '../../../contexts/ApiClientContext'
  );
  return {
    ...actual,
    useApiClient: () => stableMockClient,
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
  act(() => {
    browseResourcesSubject.next(resources);
  });
}

const buildResource = (id: string, name: string, content?: string) => ({
  '@context': 'https://www.w3.org/ns/anno.jsonld',
  '@id': id,
  name,
  content,
  representations: [{ mediaType: 'text/plain', isPrimary: true }],
});

describe('SearchModal — search wiring', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    browseResourcesSubject.next(undefined);
  });

  it('renders the search input when open', () => {
    renderWithProviders(<SearchModal {...defaultProps} />);
    expect(screen.getByPlaceholderText('Search resources, entities...')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderWithProviders(<SearchModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByPlaceholderText('Search resources, entities...')).not.toBeInTheDocument();
  });

  it('shows the start-typing hint when query is empty', () => {
    renderWithProviders(<SearchModal {...defaultProps} />);
    expect(screen.getByText('Start typing to search...')).toBeInTheDocument();
  });

  it('wires the modal to browse.resources with the correct shape', async () => {
    // One integration check that the modal calls browse.resources with the
    // limit and search shape it advertises. Pipeline mechanics (debounce,
    // empty-query gating) live in search-pipeline.test.ts.
    renderWithProviders(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search resources, entities...');

    fireEvent.change(input, { target: { value: 'marathon' } });

    await waitFor(
      () => expect(browseResourcesMock).toHaveBeenCalledWith({ search: 'marathon', limit: 5 }),
      { timeout: 1500 }
    );
  });

  it('renders results when the Observable emits a non-empty list', async () => {
    renderWithProviders(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search resources, entities...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => expect(browseResourcesMock).toHaveBeenCalled(), { timeout: 1500 });
    setBrowseResults([
      buildResource('res-1', 'Test Document', 'Some content here'),
      buildResource('res-2', 'Another Result', 'More content'),
    ]);

    await waitFor(() => {
      expect(screen.getByText('Test Document')).toBeInTheDocument();
      expect(screen.getByText('Another Result')).toBeInTheDocument();
    }, { timeout: 1500 });
  });

  it('shows the no-results message after an empty emission', async () => {
    renderWithProviders(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search resources, entities...');
    fireEvent.change(input, { target: { value: 'xyz' } });

    await waitFor(() => expect(browseResourcesMock).toHaveBeenCalled(), { timeout: 1500 });
    setBrowseResults([]);

    await waitFor(() => {
      expect(screen.getByText(/No results found for/)).toBeInTheDocument();
      expect(screen.getByText(/"xyz"/)).toBeInTheDocument();
    }, { timeout: 1500 });
  });

  it('shows the searching state while the Observable has not emitted', async () => {
    renderWithProviders(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search resources, entities...');
    fireEvent.change(input, { target: { value: 'foo' } });

    // After debounce fires, the inner observable starts with { results: [], loading: true }.
    await waitFor(() => expect(screen.getByText('Searching...')).toBeInTheDocument(), {
      timeout: 1500,
    });
  });

  it('navigates to a result and closes when clicked', async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    renderWithProviders(
      <SearchModal {...defaultProps} onClose={onClose} onNavigate={onNavigate} />
    );

    const input = screen.getByPlaceholderText('Search resources, entities...');
    fireEvent.change(input, { target: { value: 'doc' } });

    await waitFor(() => expect(browseResourcesMock).toHaveBeenCalled(), { timeout: 1500 });
    setBrowseResults([buildResource('res-1', 'Pickable', 'preview')]);

    await waitFor(() => expect(screen.getByText('Pickable')).toBeInTheDocument(), {
      timeout: 1500,
    });

    fireEvent.click(screen.getByText('Pickable'));
    expect(onNavigate).toHaveBeenCalledWith('resource', 'res-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('moves selection with arrow keys and selects with Enter', async () => {
    const onNavigate = vi.fn();
    renderWithProviders(<SearchModal {...defaultProps} onNavigate={onNavigate} />);

    const input = screen.getByPlaceholderText('Search resources, entities...');
    fireEvent.change(input, { target: { value: 'doc' } });

    await waitFor(() => expect(browseResourcesMock).toHaveBeenCalled(), { timeout: 1500 });
    setBrowseResults([
      buildResource('res-1', 'First'),
      buildResource('res-2', 'Second'),
      buildResource('res-3', 'Third'),
    ]);

    await waitFor(() => expect(screen.getByText('Third')).toBeInTheDocument(), { timeout: 1500 });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledWith('resource', 'res-3');
  });

  it('skips resources without an @id', async () => {
    renderWithProviders(<SearchModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('Search resources, entities...');
    fireEvent.change(input, { target: { value: 'q' } });

    await waitFor(() => expect(browseResourcesMock).toHaveBeenCalled(), { timeout: 1500 });
    setBrowseResults([
      { '@context': 'https://www.w3.org/ns/anno.jsonld', name: 'No ID', representations: [] },
      buildResource('res-keep', 'Has ID'),
    ]);

    await waitFor(() => expect(screen.getByText('Has ID')).toBeInTheDocument(), { timeout: 1500 });
    expect(screen.queryByText('No ID')).not.toBeInTheDocument();
  });
});
