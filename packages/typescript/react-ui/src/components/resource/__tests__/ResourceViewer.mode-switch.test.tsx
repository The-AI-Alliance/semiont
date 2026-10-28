/**
 * ResourceViewer Mode Switching Tests
 *
 * These tests ensure that switching between Browse and Annotate modes
 * doesn't cause React Hook ordering violations.
 *
 * ResourceViewer makes all its event subscriptions in a single
 * useSessionEventSubscriptions() call, so a mode switch cannot raise
 * "Rendered more hooks than during the previous render".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import { ResourceViewer } from '../ResourceViewer';
import { createTestSemiontWrapper } from '../../../test-utils';
import { ResourceAnnotationsProvider } from '../../../contexts/ResourceAnnotationsContext';
import { EventBus } from '@semiont/core';
import type { ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';

// ResourceViewer takes its session as a prop; ResourceAnnotationsContext
// resolves the client via useSemiont(). Mock useSemiont to emit a minimal
// session carrying a stub client with the methods it touches, and the bus
// its event hooks read.
const stubClient = {
  bus: new EventBus(),
  browse: { invalidateAnnotationList: vi.fn() },
  markAnnotation: vi.fn(),
};
const stubSession = {
  client: stubClient,
};
const stubActiveSession$ = new BehaviorSubject(stubSession);
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
  '@id': 'test-123' as ResourceId,
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
  t: (namespace: string, key: string) => {
    return `${namespace}.${key}`;
  },
};

function TestWrapper({ children }: { children: React.ReactNode }) {
  const { SemiontWrapper } = createTestSemiontWrapper();
  return (
    <SemiontWrapper>
      <ResourceAnnotationsProvider>
        {children}
      </ResourceAnnotationsProvider>
    </SemiontWrapper>
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
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
        />
      </TestWrapper>
    );

    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();
  });

  it('should switch to annotate mode without hook ordering errors', async () => {
    const { rerender } = render(
      <TestWrapper>
        <ResourceViewer
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
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
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
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
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
        />
      </TestWrapper>
    );

    // Toggle to annotate
    localStorage.setItem('annotateMode', 'true');
    rerender(
      <TestWrapper>
        <ResourceViewer
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
        />
      </TestWrapper>
    );
    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();

    // Toggle back to browse
    localStorage.setItem('annotateMode', 'false');
    rerender(
      <TestWrapper>
        <ResourceViewer
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
        />
      </TestWrapper>
    );
    expect(screen.getByText('This is test content for mode switching.')).toBeInTheDocument();

    // Toggle to annotate again
    localStorage.setItem('annotateMode', 'true');
    rerender(
      <TestWrapper>
        <ResourceViewer
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
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
          translationManager={mockTranslationManager}
          resource={mockResource}
          annotations={mockAnnotations}
          session={null}
        />
      </TestWrapper>
    );

    // Multiple rapid mode switches
    for (let i = 0; i < 5; i++) {
      localStorage.setItem('annotateMode', i % 2 === 0 ? 'true' : 'false');
      rerender(
        <TestWrapper>
          <ResourceViewer
            translationManager={mockTranslationManager}
            resource={mockResource}
            annotations={mockAnnotations}
            session={null}
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
