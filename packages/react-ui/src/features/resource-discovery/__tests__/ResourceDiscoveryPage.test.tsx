/**
 * Tests for ResourceDiscoveryPage component
 *
 * Tests the main resource discovery UI component.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResourceDiscoveryPage } from '../components/ResourceDiscoveryPage';
import type { ResourceDiscoveryPageProps } from '../components/ResourceDiscoveryPage';

// Mock dependencies
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    useRovingTabIndex: () => ({
      containerRef: { current: null },
      handleKeyDown: vi.fn(),
    }),
    Toolbar: () => <div data-testid="toolbar">Toolbar</div>,
  };
});

const createMockResource = (id: string, name: string, entityTypes: string[] = []) => ({
  '@context': 'https://www.w3.org/ns/anno.jsonld',
  '@id': `http://localhost/resources/${id}`,
  '@type': 'schema:DigitalDocument',
  name,
  description: `Description for ${name}`,
  entityTypes,
  archived: false,
  dateCreated: '2024-01-15T10:00:00Z',
  representations: [],
});

const createMockProps = (overrides?: Partial<ResourceDiscoveryPageProps>): ResourceDiscoveryPageProps => ({
  recentDocuments: [],
  searchDocuments: [],
  entityTypes: [],
  isLoadingRecent: false,
  isSearching: false,
  theme: 'light',
  showLineNumbers: false,
  activePanel: null,
  onNavigateToResource: vi.fn(),
  onNavigateToCompose: vi.fn(),
  translations: {
    title: 'Discover Resources',
    subtitle: 'Search and browse available resources',
    searchPlaceholder: 'Search resources...',
    searchButton: 'Search',
    searching: 'Searching...',
    filterByEntityType: 'Filter by type',
    all: 'All',
    recentResources: 'Recent Resources',
    searchResults: (count: number) => `${count} results found`,
    documentsTaggedWith: (entityType: string) => `Documents tagged with ${entityType}`,
    noResultsFound: (query: string) => `No results found for "${query}"`,
    noResourcesAvailable: 'No resources available',
    composeFirstResource: 'Compose First Resource',
    archived: 'Archived',
    created: 'Created:',
    loadingKnowledgeBase: 'Loading knowledge base...',
  },
  ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
  ...overrides,
});

describe('ResourceDiscoveryPage', () => {
  describe('Basic Rendering', () => {
    it('renders without crashing', () => {
      const props = createMockProps();
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByText('Discover Resources')).toBeInTheDocument();
    });

    it('displays page title and subtitle', () => {
      const props = createMockProps();
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByText('Discover Resources')).toBeInTheDocument();
      expect(screen.getByText('Search and browse available resources')).toBeInTheDocument();
    });

    it('renders search input', () => {
      const props = createMockProps();
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByPlaceholderText('Search resources...')).toBeInTheDocument();
    });

    it('renders search button', () => {
      const props = createMockProps();
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    });

    it('renders toolbar component', () => {
      const props = createMockProps();
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('shows loading message when isLoadingRecent is true', () => {
      const props = createMockProps({ isLoadingRecent: true });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByText('Loading knowledge base...')).toBeInTheDocument();
    });

    it('does not show main content when loading', () => {
      const props = createMockProps({ isLoadingRecent: true });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.queryByText('Discover Resources')).not.toBeInTheDocument();
    });
  });

  describe('Recent Documents Display', () => {
    it('displays recent documents', () => {
      const recentDocuments = [
        createMockResource('1', 'Document 1'),
        createMockResource('2', 'Document 2'),
        createMockResource('3', 'Document 3'),
      ];

      const props = createMockProps({ recentDocuments });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByText('Document 1')).toBeInTheDocument();
      expect(screen.getByText('Document 2')).toBeInTheDocument();
      expect(screen.getByText('Document 3')).toBeInTheDocument();
    });

    it('shows "Recent Resources" heading when no search', () => {
      const props = createMockProps({
        recentDocuments: [createMockResource('1', 'Document 1')],
      });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByText('Recent Resources')).toBeInTheDocument();
    });

    it('shows empty state when no documents', () => {
      const props = createMockProps({ recentDocuments: [] });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByText('No resources available')).toBeInTheDocument();
    });

    it('shows compose button in empty state', () => {
      const props = createMockProps({ recentDocuments: [] });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByRole('button', { name: 'Compose First Resource' })).toBeInTheDocument();
    });

    it('calls onNavigateToCompose when compose button clicked', () => {
      const props = createMockProps({ recentDocuments: [] });
      render(<ResourceDiscoveryPage {...props} />);

      const button = screen.getByRole('button', { name: 'Compose First Resource' });
      fireEvent.click(button);

      expect(props.onNavigateToCompose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Search Functionality', () => {
    it('allows typing in search input', () => {
      const props = createMockProps();
      render(<ResourceDiscoveryPage {...props} />);

      const input = screen.getByPlaceholderText('Search resources...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'test query' } });

      expect(input.value).toBe('test query');
    });

    it('shows "Searching..." when isSearching is true', () => {
      const props = createMockProps({ isSearching: true });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByRole('button', { name: 'Searching...' })).toBeInTheDocument();
    });

    it('disables search input when isSearching is true', () => {
      const props = createMockProps({ isSearching: true });
      render(<ResourceDiscoveryPage {...props} />);

      const input = screen.getByPlaceholderText('Search resources...') as HTMLInputElement;
      expect(input).toBeDisabled();
    });

    it('disables search button when isSearching is true', () => {
      const props = createMockProps({ isSearching: true });
      render(<ResourceDiscoveryPage {...props} />);

      const button = screen.getByRole('button', { name: 'Searching...' });
      expect(button).toBeDisabled();
    });

    it('displays search results with count', () => {
      const searchDocuments = [
        createMockResource('1', 'Result 1'),
        createMockResource('2', 'Result 2'),
      ];

      const props = createMockProps({ searchDocuments });
      render(<ResourceDiscoveryPage {...props} />);

      // Type in search input to trigger search state
      const input = screen.getByPlaceholderText('Search resources...');
      fireEvent.change(input, { target: { value: 'test' } });

      expect(screen.getByText('Result 1')).toBeInTheDocument();
      expect(screen.getByText('Result 2')).toBeInTheDocument();
    });

    it('shows no results warning when search returns nothing', async () => {
      const props = createMockProps({
        searchDocuments: [],
        recentDocuments: [createMockResource('1', 'Recent Doc')],
      });
      render(<ResourceDiscoveryPage {...props} />);

      const input = screen.getByPlaceholderText('Search resources...');
      fireEvent.change(input, { target: { value: 'nonexistent' } });

      await waitFor(() => {
        expect(screen.getByText('No results found for "nonexistent"')).toBeInTheDocument();
      });
    });
  });

  describe('Entity Type Filtering', () => {
    it('renders entity type filter buttons', () => {
      const props = createMockProps({
        entityTypes: ['Document', 'Article', 'Report'],
      });
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByText('Filter by type')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Document' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Article' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Report' })).toBeInTheDocument();
    });

    it('filters documents by entity type', () => {
      const props = createMockProps({
        recentDocuments: [
          createMockResource('1', 'Doc 1', ['Document']),
          createMockResource('2', 'Doc 2', ['Article']),
          createMockResource('3', 'Doc 3', ['Document']),
        ],
        entityTypes: ['Document', 'Article'],
      });
      render(<ResourceDiscoveryPage {...props} />);

      // Initially all documents shown
      expect(screen.getByText('Doc 1')).toBeInTheDocument();
      expect(screen.getByText('Doc 2')).toBeInTheDocument();
      expect(screen.getByText('Doc 3')).toBeInTheDocument();

      // Filter by Document
      const documentButton = screen.getByRole('button', { name: 'Document' });
      fireEvent.click(documentButton);

      expect(screen.getByText('Doc 1')).toBeInTheDocument();
      expect(screen.queryByText('Doc 2')).not.toBeInTheDocument();
      expect(screen.getByText('Doc 3')).toBeInTheDocument();
    });

    it('shows filtered heading when entity type selected', () => {
      const props = createMockProps({
        recentDocuments: [createMockResource('1', 'Doc 1', ['Document'])],
        entityTypes: ['Document'],
      });
      render(<ResourceDiscoveryPage {...props} />);

      const documentButton = screen.getByRole('button', { name: 'Document' });
      fireEvent.click(documentButton);

      expect(screen.getByText('Documents tagged with Document')).toBeInTheDocument();
    });

    it('resets filter when "All" button clicked', () => {
      const props = createMockProps({
        recentDocuments: [
          createMockResource('1', 'Doc 1', ['Document']),
          createMockResource('2', 'Doc 2', ['Article']),
        ],
        entityTypes: ['Document', 'Article'],
      });
      render(<ResourceDiscoveryPage {...props} />);

      // Filter by Document
      const documentButton = screen.getByRole('button', { name: 'Document' });
      fireEvent.click(documentButton);

      expect(screen.getByText('Doc 1')).toBeInTheDocument();
      expect(screen.queryByText('Doc 2')).not.toBeInTheDocument();

      // Click All
      const allButton = screen.getByRole('button', { name: 'All' });
      fireEvent.click(allButton);

      expect(screen.getByText('Doc 1')).toBeInTheDocument();
      expect(screen.getByText('Doc 2')).toBeInTheDocument();
    });
  });

  describe('Resource Navigation', () => {
    it('calls onNavigateToResource when resource card clicked', () => {
      const props = createMockProps({
        recentDocuments: [createMockResource('test-123', 'Test Document')],
      });
      render(<ResourceDiscoveryPage {...props} />);

      const card = screen.getByRole('button', { name: /Open resource: Test Document/ });
      fireEvent.click(card);

      expect(props.onNavigateToResource).toHaveBeenCalledWith('test-123');
    });
  });

  describe('Toolbar Integration', () => {
    it('renders ToolbarPanels component', () => {
      const props = createMockProps();
      render(<ResourceDiscoveryPage {...props} />);

      expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    });

    it('passes theme props to ToolbarPanels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({
        theme: 'dark',
        ToolbarPanels,
      });

      render(<ResourceDiscoveryPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: 'dark',
        }),
        expect.anything()
      );
    });
  });
});
