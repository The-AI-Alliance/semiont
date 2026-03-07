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
import { renderWithProviders } from '../../../../test-utils';
import { HighlightPanel } from '../HighlightPanel';
import type { components } from '@semiont/core';
import { resetEventBusForTesting } from '../../../../contexts/EventBusContext';

type Annotation = components['schemas']['Annotation'];

// Mock translations - simulates useTranslations('HighlightPanel')
// The mock receives keys like 'title', 'noHighlights', etc. and returns translated strings
const mockT = vi.fn((key: string) => {
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
  };
  return translations[key] || key;
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

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();

    mockAnnotations = [
      {
        id: 'highlight-1',
        motivation: 'highlighting',
        body: [],
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
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            status: 'analyzing',
            percentage: 30,
            message: 'Analyzing text for highlights...',
          }}
          annotateMode={true}
        />
      );

      // Verify AssistSection received and rendered the progress
      expect(screen.getByText('Analyzing text for highlights...')).toBeInTheDocument();
    });

    it('should pass null progress to AssistSection', () => {
      renderWithProviders(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={null}
          annotateMode={true}
        />
      );

      // Form should be visible (meaning progress was null)
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨ Annotate/ })).toBeInTheDocument();
    });

    it('should pass undefined progress to AssistSection', () => {
      renderWithProviders(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={undefined}
          annotateMode={true}
        />
      );

      // Form should be visible (meaning progress was undefined)
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨ Annotate/ })).toBeInTheDocument();
    });

    it('should keep progress visible after detection completes (isAssisting=false)', () => {
      renderWithProviders(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={{
            status: 'complete',
            percentage: 100,
            message: 'Complete! Created 14 highlights',
          }}
          annotateMode={true}
        />
      );

      // Progress should still be visible
      expect(screen.getByText('Complete! Created 14 highlights')).toBeInTheDocument();
      // Form should NOT be visible
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
    });

    it('should pass progress with request parameters to AssistSection', () => {
      renderWithProviders(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Analyzing...',
            requestParams: [
              { label: 'Instructions', value: 'Find important points' },
              { label: 'Density', value: '5' },
            ],
          }}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Request Parameters:')).toBeInTheDocument();
      expect(screen.getByText('Find important points')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  describe('Annotate Mode Toggling', () => {
    it('should render AssistSection when annotateMode is true', () => {
      renderWithProviders(
        <HighlightPanel
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
        <HighlightPanel
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
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Analyzing...',
          }}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Analyzing...')).toBeInTheDocument();

      // Switch to browse mode
      rerender(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Analyzing...',
          }}
          annotateMode={false}
        />
      );

      // Progress should be hidden
      expect(screen.queryByText('Analyzing...')).not.toBeInTheDocument();
    });
  });

  describe('State Combinations', () => {
    it('should handle isAssisting=true with no progress (starting state)', () => {
      renderWithProviders(
        <HighlightPanel
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
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={{
            status: 'complete',
            message: 'Done!',
          }}
          annotateMode={true}
        />
      );

      // Progress should be visible
      expect(screen.getByText('Done!')).toBeInTheDocument();
      // Form should be hidden
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
    });

    it('should handle multiple progress updates', () => {
      const { rerender } = renderWithProviders(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            status: 'started',
            percentage: 0,
            message: 'Starting...',
          }}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Starting...')).toBeInTheDocument();

      // Update to analyzing
      rerender(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            status: 'analyzing',
            percentage: 50,
            message: 'Analyzing...',
          }}
          annotateMode={true}
        />
      );

      expect(screen.queryByText('Starting...')).not.toBeInTheDocument();
      expect(screen.getByText('Analyzing...')).toBeInTheDocument();

      // Update to complete
      rerender(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={false}
          progress={{
            status: 'complete',
            percentage: 100,
            message: 'Complete!',
          }}
          annotateMode={true}
        />
      );

      expect(screen.queryByText('Analyzing...')).not.toBeInTheDocument();
      expect(screen.getByText('Complete!')).toBeInTheDocument();
    });
  });

  describe('Highlights List Rendering', () => {
    it('should render highlights list alongside detection progress', () => {
      renderWithProviders(
        <HighlightPanel
          annotations={mockAnnotations}
          pendingAnnotation={null}
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Analyzing...',
          }}
          annotateMode={true}
        />
      );

      // Both progress and highlights should be visible
      expect(screen.getByText('Analyzing...')).toBeInTheDocument();
      expect(screen.getByText('Highlights')).toBeInTheDocument();
    });

    it('should show empty state when no highlights', () => {
      renderWithProviders(
        <HighlightPanel
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
