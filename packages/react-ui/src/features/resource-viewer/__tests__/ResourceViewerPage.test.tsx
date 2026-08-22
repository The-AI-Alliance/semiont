/**
 * Tests for ResourceViewerPage component
 *
 * Tests the main resource viewer UI component.
 * All internal data fetching (content, annotations, etc.) is mocked at the hook level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { ResourceViewerPage } from '../components/ResourceViewerPage';
import type { ResourceViewerPageProps } from '../components/ResourceViewerPage';
import { ToastProvider } from '../../../components/Toast';
import { ThemeProvider } from '../../../contexts/ThemeContext';
import { LineNumbersProvider } from '../../../contexts/LineNumbersContext';
import { createTestSemiontWrapper } from '../../../test-utils';
import type { BodyOperation, EventMap, ResourceId, UserId } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';

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


// Stub SemiontBrowser whose activeSession$ emits a session carrying a real
// SemiontClient (wired to a dummy baseUrl). The real client surface lets
// createResourceViewerPageStateUnit run against the full namespace API without us
// hand-stubbing every method it touches.
const { stubBrowser, stubClient } = vi.hoisted(() => {
  const { BehaviorSubject } = require('rxjs');
  const { SemiontClient, HttpTransport, HttpContentTransport } = require('@semiont/sdk');
  const { baseUrl } = require('@semiont/core');
  const transport = new HttpTransport({ baseUrl: baseUrl('http://localhost:4000') });
  // HttpTransport implements both ITransport and IBackendOperations; pass it
  // as backend so `client.auth` (used by useMediaToken) is wired.
  const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
  const stubActiveSession$ = new BehaviorSubject({ client });
  const stubOpenResources$ = new BehaviorSubject([]);
  const stubBrowser = {
    activeSession$: stubActiveSession$,
    openResources$: stubOpenResources$,
    addOpenResource: vi.fn(),
    removeOpenResource: vi.fn(),
    updateOpenResourceName: vi.fn(),
    reorderOpenResources: vi.fn(),
    setLastViewedResource: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    stream: vi.fn(() => ({ subscribe: () => ({ unsubscribe: () => {} }) })),
  };
  return { stubBrowser, stubClient: client };
});

vi.mock('../../../session/SemiontProvider', async () => {
  const actual = await vi.importActual<typeof import('../../../session/SemiontProvider')>(
    '../../../session/SemiontProvider'
  );
  return {
    ...actual,
    useSemiont: () => stubBrowser,
  };
});

const capturedHistory = vi.hoisted(() => ({ props: null as any }));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    ResourceViewer: ({ resource }: any) => <div data-testid="resource-viewer">{resource.name}</div>,
    Toolbar: () => <div data-testid="toolbar">Toolbar</div>,
    ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
    UnifiedAnnotationsPanel: () => <div data-testid="annotations-panel">Annotations</div>,
    AnnotationHistory: (props: any) => {
      capturedHistory.props = props;
      return <div data-testid="history-panel">History</div>;
    },
    ResourceInfoPanel: () => <div data-testid="info-panel">Info</div>,
    CollaborationPanel: () => <div data-testid="collaboration-panel">Collaboration</div>,
    JsonLdPanel: () => <div data-testid="jsonld-panel">JSON-LD</div>,
    ErrorBoundary: ({ children }: any) => children,
    createCancelDetectionHandler: () => vi.fn(),
useDebouncedCallback: (fn: any) => fn,
    supportsDetection: () => false,
    useResourceLoadingAnnouncements: () => ({
      announceResourceLoading: vi.fn(),
      announceResourceLoaded: vi.fn(),
    }),
    useEventSubscriptions: vi.fn(),
    useResourceAnnotations: () => sparkleContext,
  };
});

// Shared, assertable spies — the page's sparkle wiring is pinned against
// these (a per-call `vi.fn()` object would be unobservable from the tests).
const sparkleContext = vi.hoisted(() => ({
  clearSparkle: vi.fn(),
  sparkleAnnotationIds: new Set<string>(),
  markAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  triggerSparkleAnimation: vi.fn(),
}));

vi.mock('../../../contexts/ResourceAnnotationsContext', () => ({
  useResourceAnnotations: () => sparkleContext,
  ResourceAnnotationsProvider: ({ children }: any) => children,
}));

// Capture what ResourceViewerPage passes to useOutcomeToasts. The real hook is a
// pure event subscription, so standing it in costs the other specs nothing.
const outcomeToastsCalls = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../hooks/useOutcomeToasts', () => ({
  useOutcomeToasts: (resourceId: unknown) => {
    outcomeToastsCalls.push(resourceId);
  },
}));

// Mock useEventSubscription at the direct path used by ResourceViewerPage
// (the barrel export mock doesn't intercept direct context imports)
const mockUseEventSubscriptions = vi.fn();
vi.mock('../../../contexts/useEventSubscription', () => ({
  useEventSubscription: vi.fn(),
  useEventSubscriptions: (...args: unknown[]) => mockUseEventSubscriptions(...args),
}));

vi.mock('@/components/toolbar/ToolbarPanels', () => ({
  ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
}));

// Create mock props matching the current ResourceViewerPageProps
const createMockProps = (overrides?: Partial<ResourceViewerPageProps>): ResourceViewerPageProps => ({
  resource: {
    '@context': 'https://www.w3.org/ns/anno.jsonld',
    '@id': 'test-123' as ResourceId,
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
  Link: ({ children }: any) => <a>{children}</a>,
  routes: {},
  refetchDocument: vi.fn().mockResolvedValue(undefined),
  streamStatus: 'open' as const,
  ToolbarPanels: ({ children, activePanel }: any) =>
    !activePanel ? null : <div data-testid="toolbar-panels">{children}</div>,
  ...overrides,
});

// Test wrapper to provide all required providers
const renderWithProviders = (ui: React.ReactElement) => {
  const { SemiontWrapper } = createTestSemiontWrapper();
  return render(
    <ThemeProvider>
      <LineNumbersProvider>
        <ToastProvider>
          <SemiontWrapper>
            {ui}
          </SemiontWrapper>
        </ToastProvider>
      </LineNumbersProvider>
    </ThemeProvider>
  );
};

describe('ResourceViewerPage — outcome toasts reach the user', () => {
  // The decline/success toast was dropped for EVERY resource:
  // `useOutcomeToasts(resource.id as string)` read a property
  // `ResourceDescriptor` does not declare (it carries `@id`). The descriptor's
  // open index signature made the access legal and the `as string` silenced its
  // `unknown` type, so the hook's `event.resourceId !== resourceId` guard
  // compared a real id against `undefined` and returned early every time.
  it('subscribes with the resource id, not a property the descriptor lacks', () => {
    outcomeToastsCalls.length = 0;
    renderWithProviders(<ResourceViewerPage {...createMockProps()} />);

    expect(outcomeToastsCalls).not.toHaveLength(0);
    // Must be the resource's identity — `undefined` here silences every toast.
    expect(outcomeToastsCalls[0]).toBe('test-123');
  });
});

// RESOLUTION-SPARKLE D2: a reference resolving — from ANY strategy, local or
// remote — arrives as mark:body-updated with a linking-add operation, and the
// page turns exactly that into a sparkle. The harness mocks
// useEventSubscriptions, so the pin drives the captured handler directly.
describe('ResourceViewerPage — resolution sparkles', () => {
  const bodyUpdated = (operations: BodyOperation[]): EventMap['mark:body-updated'] => ({
    id: 'evt-1',
    timestamp: '2026-08-21T12:00:00Z',
    resourceId: makeResourceId('test-123'),
    userId: 'did:web:example.com:users:alice' as UserId,
    version: 1,
    type: 'mark:body-updated',
    payload: { annotationId: makeAnnotationId('ann-7'), operations },
    metadata: { sequenceNumber: 1 },
  });

  const renderAndGetHandler = () => {
    mockUseEventSubscriptions.mockClear();
    sparkleContext.triggerSparkleAnimation.mockClear();
    renderWithProviders(<ResourceViewerPage {...createMockProps()} />);
    const map = mockUseEventSubscriptions.mock.calls.at(-1)?.[0] as
      Record<string, (event: EventMap['mark:body-updated']) => void>;
    return map['mark:body-updated'];
  };

  it('an operation adding a linking SpecificResource sparkles the annotation', () => {
    const handler = renderAndGetHandler();
    expect(handler).toBeDefined();

    handler!(bodyUpdated([
      { op: 'add', item: { type: 'SpecificResource', source: 'res-target', purpose: 'linking' } },
    ]));

    expect(sparkleContext.triggerSparkleAnimation).toHaveBeenCalledWith('ann-7');
  });

  it('unlink (remove-only operations) stays dark — A2', () => {
    const handler = renderAndGetHandler();

    handler?.(bodyUpdated([
      { op: 'remove', item: { type: 'SpecificResource', source: 'res-target', purpose: 'linking' } },
    ]));

    expect(sparkleContext.triggerSparkleAnimation).not.toHaveBeenCalled();
  });

  it('a TextualBody add stays dark', () => {
    const handler = renderAndGetHandler();

    handler?.(bodyUpdated([
      { op: 'add', item: { type: 'TextualBody', value: 'Person', purpose: 'tagging' } },
    ]));

    expect(sparkleContext.triggerSparkleAnimation).not.toHaveBeenCalled();
  });
});

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

    it('clicking a history event focuses that annotation in the content', () => {
      // ASSIST-SURFACE-WARTS Lane D. `handleEventClick` used to be a no-op with
      // a stale comment, while HistoryEvent still rendered a focusable button
      // labelled "View annotation" — a promise to screen-reader users that
      // nothing kept. `beckon:focus` is the existing "scroll to and highlight"
      // contract (BrowseView already subscribes); this makes the page a producer.
      localStorage.setItem('activeToolbarPanel', 'history');
      capturedHistory.props = null;
      const props = createMockProps();
      renderWithProviders(<ResourceViewerPage {...props} />);

      expect(capturedHistory.props).not.toBeNull();

      const focused: Array<string | null> = [];
      const sub = stubClient.bus.get('beckon:focus').subscribe(({ annotationId }: any) => focused.push(annotationId));

      expect(capturedHistory.props?.onEventClick).toBeTypeOf('function');
      capturedHistory.props!.onEventClick('ann-42');
      expect(focused).toEqual(['ann-42']);

      sub.unsubscribe();
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

    it('shows archived badge when the toolbar prefs hold annotate mode', () => {
      // Mode is a toolbar PREF now (TOOLBAR-PREFS-AS-PROPS): the page's
      // useToolbarPrefs() policy layer initializes from the persisted key and
      // feeds the viewer controlled props — no mark:mode-toggled bus event.
      localStorage.setItem('annotateMode', 'true');
      localStorage.setItem('activeToolbarPanel', 'annotations');

      const props = createMockProps({
        resource: {
          ...createMockProps().resource,
          archived: true,
        },
      });

      renderWithProviders(<ResourceViewerPage {...props} />);

      // annotateMode true (from the policy layer) → archived badge visible
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
