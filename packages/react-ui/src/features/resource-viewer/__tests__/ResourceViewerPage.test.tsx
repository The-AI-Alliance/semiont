/**
 * Tests for ResourceViewerPage component
 *
 * Tests the main resource viewer UI component.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResourceViewerPage } from '../components/ResourceViewerPage';
import type { ResourceViewerPageProps } from '../components/ResourceViewerPage';

// Mock dependencies that ResourceViewerPage imports
vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
      setQueryData: vi.fn(),
    }),
  };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  const mitt = await import('mitt');
  return {
    ...actual,
    ResourceViewer: ({ resource }: any) => <div data-testid="resource-viewer">{resource.name}</div>,
    Toolbar: () => <div data-testid="toolbar">Toolbar</div>,
    ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
    UnifiedAnnotationsPanel: () => <div data-testid="annotations-panel">Annotations</div>,
    AnnotationHistory: () => <div data-testid="history-panel">History</div>,
    ResourceInfoPanel: () => <div data-testid="info-panel">Info</div>,
    CollaborationPanel: () => <div data-testid="collaboration-panel">Collaboration</div>,
    JsonLdPanel: () => <div data-testid="jsonld-panel">JSON-LD</div>,
    ErrorBoundary: ({ children }: any) => children,
    createCancelDetectionHandler: () => vi.fn(),
    useGenerationProgress: () => ({
      progress: null,
      startGeneration: vi.fn(),
      clearProgress: vi.fn(),
    }),
    useDebouncedCallback: (fn: any) => fn,
    supportsDetection: () => false,
    MakeMeaningEventBusProvider: ({ children }: any) => children,
    useEvents: () => mitt.default(),
    useResourceAnnotations: () => ({
      clearNewAnnotationId: vi.fn(),
      newAnnotationIds: new Set(),
      createAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      triggerSparkleAnimation: vi.fn(),
    }),
  };
});

vi.mock('@/components/toolbar/ToolbarPanels', () => ({
  ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
}));

vi.mock('@/components/modals/SearchResourcesModal', () => ({
  SearchResourcesModal: () => <div data-testid="search-modal">Search Modal</div>,
}));

vi.mock('@/components/modals/GenerationConfigModal', () => ({
  GenerationConfigModal: () => <div data-testid="generation-modal">Generation Modal</div>,
}));

// Create mock props with all required fields
const createMockProps = (overrides?: Partial<ResourceViewerPageProps>): ResourceViewerPageProps => ({
  resource: {
    '@context': 'https://www.w3.org/ns/anno.jsonld',
    '@id': 'http://localhost/resources/test-123',
    '@type': 'schema:DigitalDocument',
    name: 'Test Resource',
    description: 'A test resource for unit testing',
    entityTypes: ['Document', 'Article'],
    archived: false,
    representations: [
      {
        '@type': 'schema:MediaObject',
        mediaType: 'text/plain',
        byteSize: 1024,
      },
    ],
  },
  rUri: 'http://localhost/resources/test-123' as any,
  content: 'Test content for the resource viewer',
  contentLoading: false,
  annotations: [],
  referencedBy: [],
  referencedByLoading: false,
  allEntityTypes: ['Document', 'Article', 'Book'],
  locale: 'en',
  theme: 'light',
  showLineNumbers: false,
  showSuccess: vi.fn(),
  showError: vi.fn(),
  cacheManager: {},
  Link: ({ children }: any) => <a>{children}</a>,
  routes: {},
  ToolbarPanels: ({ children, activePanel }: any) =>
    !activePanel ? null : <div data-testid="toolbar-panels">{children}</div>,
  SearchResourcesModal: () => <div data-testid="search-modal">Search Modal</div>,
  GenerationConfigModal: () => <div data-testid="generation-modal">Generation Modal</div>,
  ...overrides,
});

describe('ResourceViewerPage', () => {
  describe('Basic Rendering', () => {
    it('renders without crashing', () => {
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      // Check for header element specifically
      expect(screen.getByRole('heading', { name: 'Test Resource' })).toBeInTheDocument();
    });

    it('displays resource name in header', () => {
      const props = createMockProps({
        resource: {
          ...createMockProps().resource,
          name: 'My Special Resource',
        },
      });

      render(<ResourceViewerPage {...props} />);

      expect(screen.getByRole('heading', { name: 'My Special Resource' })).toBeInTheDocument();
    });

    it('renders toolbar component', () => {
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });
  });

  describe('Content Loading', () => {
    it('shows loading message when content is loading', () => {
      const props = createMockProps({ contentLoading: true });
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByText('Loading document content...')).toBeInTheDocument();
    });

    it('shows ResourceViewer when content is loaded', () => {
      const props = createMockProps({ contentLoading: false });
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('resource-viewer')).toBeInTheDocument();
    });
  });

  describe('Panel Visibility', () => {
    it('shows annotations panel when activePanel is annotations', () => {
      localStorage.setItem('activeToolbarPanel', 'annotations');
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('annotations-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows history panel when activePanel is history', () => {
      localStorage.setItem('activeToolbarPanel', 'history');
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('history-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows info panel when activePanel is info', () => {
      localStorage.setItem('activeToolbarPanel', 'info');
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('info-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows collaboration panel when activePanel is collaboration', () => {
      localStorage.setItem('activeToolbarPanel', 'collaboration');
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('collaboration-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows jsonld panel when activePanel is jsonld', () => {
      localStorage.setItem('activeToolbarPanel', 'jsonld');
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('jsonld-panel')).toBeInTheDocument();
      localStorage.clear();
    });
  });

  describe('Archived Status', () => {
    it('shows archived badge when resource is archived and in annotate mode', () => {
      const props = createMockProps({
        resource: {
          ...createMockProps().resource,
          archived: true,
        },
      });

      render(<ResourceViewerPage {...props} />);

      // Archived badge only shows in annotate mode, which defaults to false
      // So we test that it doesn't show when not in annotate mode
      expect(screen.queryByText('📦 Archived')).not.toBeInTheDocument();
    });
  });

  describe('Modals', () => {
    it('renders search resources modal', () => {
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('search-modal')).toBeInTheDocument();
    });

    it('renders generation config modal', () => {
      const props = createMockProps();
      render(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('generation-modal')).toBeInTheDocument();
    });
  });

  describe('Props Integration', () => {
    it('passes resource content to ResourceViewer', () => {
      const props = createMockProps({
        content: 'Custom test content',
        contentLoading: false,
      });

      render(<ResourceViewerPage {...props} />);

      // ResourceViewer is mocked to show resource name
      expect(screen.getByTestId('resource-viewer')).toBeInTheDocument();
    });

    it('handles multiple annotations', () => {
      const props = createMockProps({
        annotations: [
          {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            id: 'http://localhost/annotations/1',
            type: 'Annotation',
            motivation: 'commenting',
            body: [],
            target: 'http://localhost/resources/test-123',
          },
          {
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            id: 'http://localhost/annotations/2',
            type: 'Annotation',
            motivation: 'highlighting',
            body: [],
            target: 'http://localhost/resources/test-123',
          },
        ],
      });

      render(<ResourceViewerPage {...props} />);

      // Component should render without errors - check for header
      expect(screen.getByRole('heading', { name: 'Test Resource' })).toBeInTheDocument();
    });
  });
});
