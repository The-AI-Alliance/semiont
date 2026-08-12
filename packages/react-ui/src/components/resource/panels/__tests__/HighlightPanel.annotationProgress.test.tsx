/**
 * Layer 2 Integration Test: HighlightPanel + AssistSection
 *
 * Tests the integration between HighlightPanel and AssistSection components.
 * Verifies that progress prop is correctly passed down the component tree.
 *
 * This is a Layer 2 test because it:
 * - Tests multiple real React components together (HighlightPanel + AssistSection)
 * - Uses real EventBus for browse:click events
 * - Mocks API and external dependencies
 * - Tests the data flow between parent and child components
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import { renderWithProviders, createTestSemiontWrapper } from '../../../../test-utils';
import { HighlightPanel } from '../HighlightPanel';
import type { SemiontSession } from '@semiont/sdk';

import type { Annotation, AnnotationId } from '@semiont/core';

// Mock translations - simulates useTranslations('HighlightPanel')
// The mock receives keys like 'title', 'noHighlights', etc. and returns translated strings
const mockT = vi.fn((key: string, params?: Record<string, unknown>) => {
  const translations: Record<string, string> = {
    title: 'Highlights',
    noHighlights: 'No highlights yet',
    annotateHighlights: 'Annotate Highlights',
    instructions: 'Instructions',
    optional: '(optional)',
    instructionsPlaceholder: 'Enter custom instructions...',
    densityLabel: 'Density',
    densitySparse: 'Sparse',
    densityDense: 'Dense',
    annotate: 'Annotate',
    annotating: 'Annotating...',
  };
  // P3: the coded status line. Interpolates `{{var}}` like production —
  // a mock that ignored params would let copy that cannot interpolate in the
  // app still pass here.
  Object.assign(translations, {
    codeLoading: 'Loading…',
    codeAnalyzing: 'Marking…',
    codeDetectingEntities: 'Marking…',
    codeCompleteCreated: 'Created {{count}} {{kind}}',
    kindHighlight: 'highlights',
    subject: '{{label}}',
    subjectWithPosition: '{{label}} ({{done}} of {{total}})',
  });
  let out = translations[key] || key;
  for (const [k, v] of Object.entries((params ?? {}) as Record<string, unknown>)) {
    out = out.replace(`{{${k}}}`, String(v));
  }
  return out;
});

vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: () => mockT,
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../../../contexts/useEventSubscription', () => ({
  useEventSubscriptions: vi.fn(),
}));

describe('HighlightPanel + AssistSection Integration', () => {
  let mockAnnotations: Annotation[];
  // Created per-test: test-utils disposes every created client in a
  // module-scope afterEach, so a module-scope session would be dead
  // after the first test.
  let session: SemiontSession;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ session } = createTestSemiontWrapper());

    mockAnnotations = [
      {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: 'highlight-1' as AnnotationId,
        motivation: 'highlighting',
        target: {
          source: 'resource-1',
          selector: {
            type: 'TextPositionSelector',
            start: 0,
            end: 10,
          },
        },
        created: '2024-01-01T00:00:00Z',
      },
    ];
  });

  describe('Detection Progress Prop Passing', () => {
    it('should pass progress to AssistSection when provided', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            stage: 'analyzing',
            percentage: 30,
          }}
          annotateMode={true}
        />
      );

      // Verify AssistSection received and rendered the progress
      expect(screen.getByText('Annotating...')).toBeInTheDocument();
    });

    it('should pass null progress to AssistSection', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={null}
          annotateMode={true}
        />
      );

      // Form should be visible (meaning progress was null)
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨\s*Annotate/ })).toBeInTheDocument();
    });

    it('should pass undefined progress to AssistSection', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={undefined}
          annotateMode={true}
        />
      );

      // Form should be visible (meaning progress was undefined)
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨\s*Annotate/ })).toBeInTheDocument();
    });

    it('should keep progress visible after detection completes (isAssisting=false)', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={{
            stage: 'complete',
            message: { code: 'complete-created', count: 3, kind: 'highlight' },
            percentage: 100,
          }}
          annotateMode={true}
        />
      );

      // Progress should still be visible
      expect(screen.getByText('Created 3 highlights')).toBeInTheDocument();
      // Form should NOT be visible
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
    });

    it('should pass progress with request parameters to AssistSection', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            stage: 'analyzing',
            percentage: 0,
            requestParams: [
              { label: 'Instructions', value: 'Find important points' },
              { label: 'Density', value: '5' },
            ],
          }}
          annotateMode={true}
        />
      );

      expect(screen.getByTestId('semiont-assist-params')).toBeInTheDocument();
      expect(screen.getByText('Find important points')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  describe('Annotate Mode Toggling', () => {
    it('should render AssistSection when annotateMode is true', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={null}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Annotate Highlights')).toBeInTheDocument();
    });

    it('should NOT render AssistSection when annotateMode is false', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={null}
          annotateMode={false}
        />
      );

      expect(screen.queryByText('Annotate Highlights')).not.toBeInTheDocument();
    });

    it('should hide progress when switching to browse mode (annotateMode=false)', () => {
      const { rerender } = renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            stage: 'analyzing',
            percentage: 0,
          }}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Annotating...')).toBeInTheDocument();

      // Switch to browse mode
      rerender(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            stage: 'analyzing',
            percentage: 0,
          }}
          annotateMode={false}
        />
      );

      // Progress should be hidden
      expect(screen.queryByText('Annotating...')).not.toBeInTheDocument();
    });
  });

  describe('State Combinations', () => {
    it('should handle isAssisting=true with no progress (starting state)', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={null}
          annotateMode={true}
        />
      );

      // Form should still be visible (waiting for first progress chunk)
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
    });

    it('should handle isAssisting=false with progress (final state)', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={{
            stage: 'complete',
            message: { code: 'complete-created', count: 3, kind: 'highlight' },
            percentage: 100,
          }}
          annotateMode={true}
        />
      );

      // Progress should be visible
      expect(screen.getByText('Created 3 highlights')).toBeInTheDocument();
      // Form should be hidden
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
    });

    it('should handle multiple progress updates', () => {
      const { rerender } = renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            stage: 'started',
            percentage: 0,
          }}
          annotateMode={true}
        />
      );

      // Stage is the observable across non-terminal updates now that the
      // status text is a single translated string (the wire carries codes).
      expect(document.querySelector('.semiont-assist-progress')).toHaveAttribute('data-ended', 'false');

      // Update to analyzing
      rerender(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            stage: 'analyzing',
            percentage: 50,
          }}
          annotateMode={true}
        />
      );

      expect(document.querySelector('.semiont-assist-progress')).toHaveAttribute('data-ended', 'false');
      expect(screen.getByText('Annotating...')).toBeInTheDocument();

      // Update to complete
      rerender(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={{
            stage: 'complete',
            message: { code: 'complete-created', count: 3, kind: 'highlight' },
            percentage: 100,
          }}
          annotateMode={true}
        />
      );

      expect(screen.queryByText('Annotating...')).not.toBeInTheDocument();
      expect(screen.getByText('Created 3 highlights')).toBeInTheDocument();
    });
  });

  describe('Highlights List Rendering', () => {
    it('should render highlights list alongside detection progress', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            stage: 'analyzing',
            percentage: 0,
          }}
          annotateMode={true}
        />
      );

      // Both progress and highlights should be visible
      expect(screen.getByText('Annotating...')).toBeInTheDocument();
      expect(screen.getByText('Highlights')).toBeInTheDocument();
    });

    it('should show empty state when no highlights', () => {
      renderWithProviders(
        <HighlightPanel session={session} resourceId="res-1"
          annotations={[]}
          pendingAnnotation={null}
          isAssisting={false}
          progress={null}
          annotateMode={true}
        />
      );

      expect(screen.getByText('No highlights yet')).toBeInTheDocument();
    });
  });
});
