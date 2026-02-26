/**
 * Layer 1 Unit Test: AssistSection Component
 *
 * Tests the AssistSection component in isolation with mocked dependencies.
 *
 * This test verifies:
 * - Detection progress rendering when progress prop is provided
 * - Progress message display
 * - Request parameters display
 * - Form visibility toggling based on progress state
 * - Event emission when detect button clicked
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import { AssistSection } from '../AssistSection';
import { resetEventBusForTesting } from '../../../../contexts/EventBusContext';
import type { EventBus } from "@semiont/core"

// Mock translations
const mockT = vi.fn((key: string) => {
  const translations: Record<string, string> = {
    annotateHighlights: 'Annotate Highlights',
    annotateAssessments: 'Annotate Assessments',
    annotateComments: 'Annotate Comments',
    instructions: 'Instructions',
    optional: '(optional)',
    instructionsPlaceholder: 'Enter custom instructions...',
    toneLabel: 'Tone',
    toneOptional: '(optional)',
    toneScholarly: 'Scholarly',
    toneExplanatory: 'Explanatory',
    toneConversational: 'Conversational',
    toneTechnical: 'Technical',
    toneAnalytical: 'Analytical',
    toneCritical: 'Critical',
    toneBalanced: 'Balanced',
    toneConstructive: 'Constructive',
    densityLabel: 'Density',
    densitySparse: 'Sparse',
    densityDense: 'Dense',
    annotate: 'Annotate',
    annotating: 'Annotating...',
  };
  return translations[key] || key;
});

vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: () => mockT,
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('AssistSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();
    // Clear localStorage
    if (typeof window !== 'undefined') {
      localStorage.clear();
    }
  });

  describe('Progress Display', () => {
    it('should render progress message when progress prop provided', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={true}
          progress={{
            status: 'analyzing',
            percentage: 30,
            message: 'Analyzing text for highlights...',
          }}
        />
      );

      expect(screen.getByText('Analyzing text for highlights...')).toBeInTheDocument();
    });

    it('should render progress message with sparkle icon', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Processing...',
          }}
        />
      );

      // Check for icon and message
      const progressDiv = screen.getByText('Processing...').closest('.semiont-annotation-progress__message');
      expect(progressDiv).toBeInTheDocument();
      expect(progressDiv?.querySelector('.semiont-annotation-progress__icon')).toBeInTheDocument();
    });

    it('should render request parameters when provided', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Analyzing...',
            requestParams: [
              { label: 'Instructions', value: 'Find important points' },
              { label: 'Density', value: '5' },
            ],
          }}
        />
      );

      expect(screen.getByText('Request Parameters:')).toBeInTheDocument();
      expect(screen.getByText('Find important points')).toBeInTheDocument();
      expect(screen.getByText(/Instructions:/)).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText(/Density:/)).toBeInTheDocument();
    });

    it('should hide form when progress is present', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Analyzing...',
          }}
        />
      );

      // Form should not be visible
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /✨ Annotate/ })).not.toBeInTheDocument();
    });

    it('should show form when progress is null', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />
      );

      // Form should be visible
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨ Annotate/ })).toBeInTheDocument();
    });

    it('should show form when progress is undefined', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={undefined}
        />
      );

      // Form should be visible
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨ Annotate/ })).toBeInTheDocument();
    });

    it('should keep progress visible after detection completes (isAssisting=false but progress exists)', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={{
            status: 'complete',
            percentage: 100,
            message: 'Complete! Created 14 highlights',
          }}
        />
      );

      // Progress should still be visible
      expect(screen.getByText('Complete! Created 14 highlights')).toBeInTheDocument();
      // Form should NOT be visible
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
    });
  });

  describe('Annotation Type Variations', () => {
    it('should render for highlight type', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />
      );

      expect(screen.getByText('Annotate Highlights')).toBeInTheDocument();
    });

    it('should render for assessment type', () => {
      renderWithProviders(
        <AssistSection
          annotationType="assessment"
          isAssisting={false}
          progress={null}
        />
      );

      expect(screen.getByText('Annotate Assessments')).toBeInTheDocument();
    });

    it('should render for comment type', () => {
      renderWithProviders(
        <AssistSection
          annotationType="comment"
          isAssisting={false}
          progress={null}
        />
      );

      expect(screen.getByText('Annotate Comments')).toBeInTheDocument();
    });

    it('should show tone selector for comments', () => {
      renderWithProviders(
        <AssistSection
          annotationType="comment"
          isAssisting={false}
          progress={null}
        />
      );

      expect(screen.getByText('Scholarly')).toBeInTheDocument();
      expect(screen.getByText('Explanatory')).toBeInTheDocument();
    });

    it('should show tone selector for assessments', () => {
      renderWithProviders(
        <AssistSection
          annotationType="assessment"
          isAssisting={false}
          progress={null}
        />
      );

      expect(screen.getByText('Analytical')).toBeInTheDocument();
      expect(screen.getByText('Critical')).toBeInTheDocument();
    });

    it('should not show tone selector for highlights', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />
      );

      expect(screen.queryByText('Scholarly')).not.toBeInTheDocument();
      expect(screen.queryByText('Analytical')).not.toBeInTheDocument();
    });
  });

  describe('Event Emission', () => {
    it('should emit annotate:detect-request event when detect button clicked', async () => {
      const user = userEvent.setup();
      const detectionHandler = vi.fn();

      const { eventBus } = renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('annotate:assist-request').subscribe(detectionHandler);

      const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        motivation: 'highlighting',
        options: expect.any(Object),
      });

      subscription.unsubscribe();
    });

    it('should emit correct motivation for assessment type', async () => {
      const user = userEvent.setup();
      const detectionHandler = vi.fn();

      const { eventBus } = renderWithProviders(
        <AssistSection
          annotationType="assessment"
          isAssisting={false}
          progress={null}
        />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('annotate:assist-request').subscribe(detectionHandler);

      const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        motivation: 'assessing',
        options: expect.any(Object),
      });

      subscription.unsubscribe();
    });

    it('should emit correct motivation for comment type', async () => {
      const user = userEvent.setup();
      const detectionHandler = vi.fn();

      const { eventBus } = renderWithProviders(
        <AssistSection
          annotationType="comment"
          isAssisting={false}
          progress={null}
        />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('annotate:assist-request').subscribe(detectionHandler);

      const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        motivation: 'commenting',
        options: expect.any(Object),
      });

      subscription.unsubscribe();
    });

    it('should include instructions in event when provided', async () => {
      const user = userEvent.setup();
      const detectionHandler = vi.fn();

      const { eventBus } = renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('annotate:assist-request').subscribe(detectionHandler);

      const textarea = screen.getByPlaceholderText('Enter custom instructions...');
      await user.type(textarea, 'Find key concepts');

      const annotateButton = screen.getByRole('button', { name: /✨ Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        motivation: 'highlighting',
        options: {
          instructions: 'Find key concepts',
          density: expect.any(Number),
        },
      });

      subscription.unsubscribe();
    });
  });

  describe('Collapsible Behavior', () => {
    it('should be expanded by default', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />
      );

      const collapseButton = screen.getByRole('button', { name: /Annotate Highlights/ });
      expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
    });

    it('should collapse when title clicked', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />
      );

      const collapseButton = screen.getByRole('button', { name: /Annotate Highlights/ });
      await user.click(collapseButton);

      expect(collapseButton).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
    });

    it('should expand when title clicked again', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={false}
          progress={null}
        />
      );

      const collapseButton = screen.getByRole('button', { name: /Annotate Highlights/ });
      await user.click(collapseButton); // Collapse
      await user.click(collapseButton); // Expand

      expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty progress message', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: '',
          }}
        />
      );

      // Should render progress section even with empty message
      const progressDiv = document.querySelector('.semiont-annotation-progress');
      expect(progressDiv).toBeInTheDocument();
    });

    it('should handle progress without percentage', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Processing...',
            // no percentage
          }}
        />
      );

      expect(screen.getByText('Processing...')).toBeInTheDocument();
    });

    it('should handle progress with empty requestParams array', () => {
      renderWithProviders(
        <AssistSection
          annotationType="highlight"
          isAssisting={true}
          progress={{
            status: 'analyzing',
            message: 'Processing...',
            requestParams: [],
          }}
        />
      );

      expect(screen.queryByText('Request Parameters:')).not.toBeInTheDocument();
    });
  });
});
