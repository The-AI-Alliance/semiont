/**
 * ResourceViewer Mode Switching Tests
 *
 * These tests ensure that switching between Browse and Annotate modes
 * doesn't cause React Hook ordering violations.
 *
 * Bug: Previously had 3 separate useEventSubscriptions() calls causing
 * "Rendered more hooks than during the previous render" error.
 *
 * Fix: Combined all event subscriptions into a single useEventSubscriptions() call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import { ResourceViewer } from '../ResourceViewer';
import { EventBusProvider } from '../../../contexts/EventBusContext';
import { TranslationProvider } from '../../../contexts/TranslationContext';
import { ResourceAnnotationsProvider } from '../../../contexts/ResourceAnnotationsContext';
import { ApiClientProvider } from '../../../contexts/ApiClientContext';
import { AuthTokenProvider } from '../../../contexts/AuthTokenContext';
import type { components } from '@semiont/core';

type SemiontResource = components['schemas']['ResourceDescriptor'];

// Mock dependencies
vi.mock('../../../hooks/useObservableBrowse', () => ({
  useObservableExternalNavigation: () => vi.fn(),
}));

// ResourceViewer (and ResourceAnnotationsContext) now resolve the client via
// useSemiont(). Mock useSemiont to emit a minimal session carrying a stub
// client with the methods the subject component touches.
const stubClient = {
  browse: { invalidateAnnotationList: vi.fn() },
  markAnnotation: vi.fn(),
};
const stubActiveSession$ = new BehaviorSubject<any>({ client: stubClient });
const stubBrowser = { activeSession$: stubActiveSession$ };

vi.mock('../../../session/SemiontProvider', async () => {
  const actual = await vi.importActual<typeof import('../../../session/SemiontProvider')>(
    '../../../session/SemiontProvider'
  );
  return {
    ...actual,
    useSemiont: () => stubBrowser,
  };
});

const mockResource: SemiontResource & { content: string } = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  '@id': 'test-123',
  name: 'Test Document',
  created: '2024-01-01T00:00:00Z',
  entityTypes: [],
  archived: false,
  representations: [
    {
      mediaType: 'text/plain',
      byteSize: 100,
    },
  ],
  content: 'This is test content for mode switching.',
};

const mockAnnotations = {
  highlights: [],
  references: [],
  assessments: [],
  comments: [],
  tags: [],
};

const mockTranslationManager = {
  t: (namespace: string, key: string, params?: Record<string, any>) => {
    return `${namespace}.${key}`;
  },
};

function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <TranslationProvider translationManager={mockTranslationManager}>
      <EventBusProvider>
        <AuthTokenProvider token="test-token">
          <ApiClientProvider baseUrl="http://localhost:4000">
            <ResourceAnnotationsProvider>
              {children}
            </ResourceAnnotationsProvider>
          </ApiClientProvider>
        </AuthTokenProvider>
      </EventBusProvider>
    </TranslationProvider>
  );
}

describe('ResourceViewer - Mode Switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage before each test
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('should render without crashing in browse mode', () => {
    render(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );

    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();
  });

  it('should switch to annotate mode without hook ordering errors', async () => {
    const { rerender } = render(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );

    // Initial render in browse mode
    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();

    // Simulate mode toggle by setting localStorage and triggering re-render
    localStorage.setItem('annotateMode', 'true');

    // Re-render (simulating what would happen when the event fires)
    rerender(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );

    // Should still render without errors
    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();
  });

  it('should toggle between browse and annotate modes multiple times without errors', async () => {
    const { rerender } = render(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );

    // Toggle to annotate
    localStorage.setItem('annotateMode', 'true');
    rerender(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );
    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();

    // Toggle back to browse
    localStorage.setItem('annotateMode', 'false');
    rerender(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );
    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();

    // Toggle to annotate again
    localStorage.setItem('annotateMode', 'true');
    rerender(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );
    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();

    // No React Hook ordering errors should occur
  });

  it('should maintain consistent hook calls across mode switches', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <TestWrapper>
        <ResourceViewer
          resource={mockResource}
          annotations={mockAnnotations}
        />
      </TestWrapper>
    );

    // Multiple rapid mode switches
    for (let i = 0; i < 5; i++) {
      localStorage.setItem('annotateMode', i % 2 === 0 ? 'true' : 'false');
      rerender(
        <TestWrapper>
          <ResourceViewer
            resource={mockResource}
            annotations={mockAnnotations}
          />
        </TestWrapper>
      );
    }

    // Should not have any React Hook warnings
    const hookErrors = consoleError.mock.calls.filter(call =>
      call[0]?.toString().includes('Rendered more hooks') ||
      call[0]?.toString().includes('Rendered fewer hooks')
    );

    expect(hookErrors).toHaveLength(0);

    consoleError.mockRestore();
  });
});
