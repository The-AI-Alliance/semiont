/**
 * Tests for ResourceViewerPage component
 *
 * Tests the main resource viewer UI component.
 * All internal data fetching (content, annotations, etc.) is mocked at the hook level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { ResourceViewerPage } from '../components/ResourceViewerPage';
import type { ResourceViewerPageProps } from '../components/ResourceViewerPage';
// Import directly from context file to bypass mocked barrel export
import { EventBusProvider } from '../../../contexts/EventBusContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import { ToastProvider } from '../../../components/Toast';
import { ThemeProvider } from '../../../contexts/ThemeContext';

// jsdom doesn't implement window.matchMedia — mock it for useTheme
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock internal hooks that fetch data
vi.mock('../../../hooks/useResourceContent', () => ({
  useResourceContent: () => ({ content: 'Test content', loading: false }),
}));

vi.mock('../../../lib/api-hooks', () => ({
  useResources: () => ({
    annotations: { useQuery: () => ({ data: { annotations: [] } }) },
    referencedBy: { useQuery: () => ({ data: { referencedBy: [] }, isLoading: false }) },
    update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    generateCloneToken: { useMutation: () => ({ mutateAsync: vi.fn() }) },
  }),
  useEntityTypes: () => ({
    list: { useQuery: () => ({ data: { entityTypes: ['Document', 'Article', 'Book'] } }) },
  }),
}));

vi.mock('../../../hooks/useResourceEvents', () => ({
  useResourceEvents: () => null,
}));

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
useDebouncedCallback: (fn: any) => fn,
    supportsDetection: () => false,
    MakeMeaningEventBusProvider: ({ children }: any) => children,
    useResourceLoadingAnnouncements: () => ({
      announceResourceLoading: vi.fn(),
      announceResourceLoaded: vi.fn(),
    }),
    // Don't mock EventBusProvider, useEventBus - let actual pass through via ...actual
    useEventSubscriptions: vi.fn(),
    useResourceAnnotations: () => ({
      clearNewAnnotationId: vi.fn(),
      newAnnotationIds: new Set(),
      markAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      triggerSparkleAnimation: vi.fn(),
    }),
  };
});

vi.mock('../../../contexts/OpenResourcesContext', () => ({
  useOpenResources: () => ({
    openResources: [],
    addResource: vi.fn(),
    removeResource: vi.fn(),
    isResourceOpen: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock('../../../contexts/ResourceAnnotationsContext', () => ({
  useResourceAnnotations: () => ({
    clearNewAnnotationId: vi.fn(),
    newAnnotationIds: new Set(),
    markAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    triggerSparkleAnimation: vi.fn(),
  }),
  ResourceAnnotationsProvider: ({ children }: any) => children,
}));

// Mock useEventSubscription at the direct path used by ResourceViewerPage
// (the barrel export mock doesn't intercept direct context imports)
const mockUseEventSubscriptions = vi.fn();
vi.mock('../../../contexts/useEventSubscription', () => ({
  useEventSubscriptions: (...args: unknown[]) => mockUseEventSubscriptions(...args),
}));

vi.mock('@/components/toolbar/ToolbarPanels', () => ({
  ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
}));

// Create mock props matching the current ResourceViewerPageProps
const createMockProps = (overrides?: Partial<ResourceViewerPageProps>): ResourceViewerPageProps => ({
  resource: {
    '@context': 'https://www.w3.org/ns/anno.jsonld',
    '@id': 'test-123',
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
  rUri: 'test-123' as any,
  locale: 'en',
  cacheManager: {},
  Link: ({ children }: any) => <a>{children}</a>,
  routes: {},
  refetchDocument: vi.fn().mockResolvedValue(undefined),
  streamStatus: 'connected' as const,
  ToolbarPanels: ({ children, activePanel }: any) =>
    !activePanel ? null : <div data-testid="toolbar-panels">{children}</div>,
  ...overrides,
});

// Test wrapper to provide all required providers
const renderWithProviders = (ui: React.ReactElement) => {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <AuthTokenProvider token={null}>
          <ApiClientProvider baseUrl="http://localhost:4000">
            <EventBusProvider>{ui}</EventBusProvider>
          </ApiClientProvider>
        </AuthTokenProvider>
      </ToastProvider>
    </ThemeProvider>
  );
};

describe('ResourceViewerPage', () => {
  beforeEach(() => {
  });

  describe('Basic Rendering', () => {
    it('renders without crashing', () => {
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

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

      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByRole('heading', { name: 'My Special Resource' })).toBeInTheDocument();
    });

    it('renders toolbar component', () => {
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });
  });

  describe('Content Loading', () => {
    it('shows ResourceViewer when content is loaded', () => {
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('resource-viewer')).toBeInTheDocument();
    });
  });

  describe('Panel Visibility', () => {
    it('shows annotations panel when activePanel is annotations', () => {
      localStorage.setItem('activeToolbarPanel', 'annotations');
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('annotations-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows history panel when activePanel is history', () => {
      localStorage.setItem('activeToolbarPanel', 'history');
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('history-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows info panel when activePanel is info', () => {
      localStorage.setItem('activeToolbarPanel', 'info');
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('info-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows collaboration panel when activePanel is collaboration', () => {
      localStorage.setItem('activeToolbarPanel', 'collaboration');
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('collaboration-panel')).toBeInTheDocument();
      localStorage.clear();
    });

    it('shows jsonld panel when activePanel is jsonld', () => {
      localStorage.setItem('activeToolbarPanel', 'jsonld');
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('jsonld-panel')).toBeInTheDocument();
      localStorage.clear();
    });
  });

  describe('Archived Status', () => {
    it('does not show archived badge when not in annotate mode', () => {
      const props = createMockProps({
        resource: {
          ...createMockProps().resource,
          archived: true,
        },
      });

      renderWithProviders(<ResourceViewerPage {...props} />);

      // Archived badge only shows in annotate mode, which defaults to false
      expect(screen.queryByText('📦 Archived')).not.toBeInTheDocument();
    });

    it('shows archived badge after mark:mode-toggled event fires', () => {
      localStorage.setItem('annotateMode', 'false');
      localStorage.setItem('activeToolbarPanel', 'annotations');

      const props = createMockProps({
        resource: {
          ...createMockProps().resource,
          archived: true,
        },
      });

      renderWithProviders(<ResourceViewerPage {...props} />);

      // Before toggle: annotateMode is false, so archived badge is hidden
      expect(screen.queryByText('📦 Archived')).not.toBeInTheDocument();

      // Get the handler map that ResourceViewerPage passed to useEventSubscriptions
      const handlerMap = mockUseEventSubscriptions.mock.calls[mockUseEventSubscriptions.mock.calls.length - 1]?.[0] as Record<string, () => void>;
      expect(handlerMap).toBeDefined();
      expect(handlerMap['mark:mode-toggled']).toBeDefined();

      // Fire the mode toggle — this is what the toolbar emits
      act(() => {
        handlerMap['mark:mode-toggled']();
      });

      // After toggle: annotateMode is true, so archived badge should appear
      expect(screen.getByText('📦 Archived')).toBeInTheDocument();

      localStorage.clear();
    });
  });

  describe('Modals', () => {
    it('renders reference wizard modal', () => {
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      // Wizard modal is rendered but closed by default
      // It opens when bind:initiate is emitted from ReferenceEntry
    });
  });

  describe('Props Integration', () => {
    it('renders ResourceViewer component', () => {
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByTestId('resource-viewer')).toBeInTheDocument();
    });

    it('renders with different resource names', () => {
      const props = createMockProps({
        resource: {
          ...createMockProps().resource,
          name: 'Different Resource Name',
        },
      });

      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(screen.getByRole('heading', { name: 'Different Resource Name' })).toBeInTheDocument();
    });
  });
});
