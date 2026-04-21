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
import { createTestSemiontWrapper } from '../../../test-utils';
import { TranslationProvider } from '../../../contexts/TranslationContext';
import { ResourceAnnotationsProvider } from '../../../contexts/ResourceAnnotationsContext';
import type { components } from '@semiont/core';

type SemiontResource = components['schemas']['ResourceDescriptor'];

// Mock dependencies
vi.mock('../../../hooks/useObservableBrowse', () => ({
  useObservableExternalNavigation: () => vi.fn(),
}));

// ResourceViewer (and ResourceAnnotationsContext) now resolve the client via
// useSemiont(). Mock useSemiont to emit a minimal session carrying a stub
// client with the methods the subject component touches. The session also
// exposes `on` and `emit` stubs so useEventSubscription(s) don't explode.
const stubClient = {
  browse: { invalidateAnnotationList: vi.fn() },
  markAnnotation: vi.fn(),
  on: vi.fn(() => () => {}),
  emit: vi.fn(),
  stream: vi.fn(() => ({ subscribe: () => ({ unsubscribe: () => {} }) })),
};
const stubSession = {
  client: stubClient,
};
const stubActiveSession$ = new BehaviorSubject<any>(stubSession);
const stubBrowser = {
  activeSession$: stubActiveSession$,
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
  stream: vi.fn(() => ({ subscribe: () => ({ unsubscribe: () => {} }) })),
};

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
  const { SemiontWrapper } = createTestSemiontWrapper();
  return (
    <TranslationProvider translationManager={mockTranslationManager}>
      <SemiontWrapper>
        <ResourceAnnotationsProvider>
          {children}
        </ResourceAnnotationsProvider>
      </SemiontWrapper>
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
