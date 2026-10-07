/**
 * Layer 1 Unit Test: DelegateSection Component
 *
 * Tests the DelegateSection component in isolation with mocked dependencies.
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
import { renderWithProviders, createTestSemiontWrapper } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import type { EventBus } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { DelegateSection } from '../DelegateSection';

// Mock translations
const mockT = vi.fn((key: string, params?: Record<string, unknown>) => {
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
  // The coded status line. Interpolates `{{var}}` like production —
  // a mock that ignored params would let copy that cannot interpolate in the
  // app still pass here.
  Object.assign(translations, {
    codeLoading: 'Loading…',
    codeAnalyzing: 'Marking…',
    codeDetectingEntities: 'Marking…',
    codeCompleteCreated: 'Created {{count}} {{noun}}',
    nounHighlighting: 'highlights',
    subject: '{{kind}}: {{label}}',
    subjectWithPosition: '{{kind}}: {{label}} ({{done}} of {{total}})',
    subjectKindEntityType: 'Entity type',
    subjectKindCategory: 'Category',
    // The widget's own strings come from the
    // DelegateProgress namespace, not from each panel's.
    cancel: 'Cancel',
    inProgress: 'Annotating...',
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

describe('DelegateSection', () => {
  // Per-test session/bus — created in beforeEach (a module-scope factory
  // call would hand tests a client that test-utils disposes after the
  // first test). The `session` prop and the `eventBus` the emission
  // tests subscribe come from the SAME factory call.
  let session: SemiontSession;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ session, eventBus } = createTestSemiontWrapper());
    // Clear localStorage
    if (typeof window !== 'undefined') {
      localStorage.clear();
    }
  });

  describe('Progress Display', () => {
    it('should render the translated status line when progress prop provided', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={true}
          progress={{
            percentage: 30,
          }}
        />
      );

      expect(screen.getByText('Annotating...')).toBeInTheDocument();
    });

    it('should render the status line with sparkle icon', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={true}
          progress={{
            percentage: 0,
          }}
        />
      );

      // Check for icon and status text
      const progressDiv = screen.getByText('Annotating...').closest('.semiont-delegate-progress__status');
      expect(progressDiv).toBeInTheDocument();
      expect(progressDiv?.querySelector('.semiont-delegate-progress__icon')).toBeInTheDocument();
    });

    it('should render request parameters when provided', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={true}
          progress={{
            percentage: 0,
            requestParams: [
              { label: 'instructions', value: 'Find important points' },
              { label: 'density', value: '5' },
            ],
          }}
        />
      );

      expect(screen.getByTestId('semiont-delegate-params')).toBeInTheDocument();
      expect(screen.getByText('Find important points')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
      // The wire carries a CODE; the label the user reads is LOOKED UP. Under
      // the test translator that lookup echoes the key, so seeing the key is
      // the assertion that the label went through translation — and that the
      // raw wire code ('instructions') never reaches the screen.
      expect(screen.getByText(/paramInstructions:/)).toBeInTheDocument();
      expect(screen.getByText(/paramDensity:/)).toBeInTheDocument();
      expect(screen.queryByText(/^instructions:/)).toBeNull();
    });

    it('should hide form when progress is present', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={true}
          progress={{
            percentage: 0,
          }}
        />
      );

      // Form should not be visible
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /✨\s*Annotate/ })).not.toBeInTheDocument();
    });

    it('should show form when progress is null', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
          progress={null}
        />
      );

      // Form should be visible
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨\s*Annotate/ })).toBeInTheDocument();
    });

    it('should show form when progress is undefined', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
          progress={undefined}
        />
      );

      // Form should be visible
      expect(screen.getByPlaceholderText('Enter custom instructions...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /✨\s*Annotate/ })).toBeInTheDocument();
    });

    it('should keep progress visible after detection completes (isDelegating=false but progress exists)', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
          progress={{
            message: { code: 'complete-created', count: 3, motivation: 'highlighting' },
            percentage: 100,
          }}
        />
      );

      // Progress should still be visible, with the translated terminal copy
      expect(screen.getByText('Created 3 highlights')).toBeInTheDocument();
      // Form should NOT be visible
      expect(screen.queryByPlaceholderText('Enter custom instructions...')).not.toBeInTheDocument();
    });
  });

  describe('Annotation Type Variations', () => {
    it('should render for highlight type', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
          progress={null}
        />
      );

      expect(screen.getByText('Annotate Highlights')).toBeInTheDocument();
    });

    it('should render for assessment type', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="assessment"
          isDelegating={false}
          progress={null}
        />
      );

      expect(screen.getByText('Annotate Assessments')).toBeInTheDocument();
    });

    it('should render for comment type', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="comment"
          isDelegating={false}
          progress={null}
        />
      );

      expect(screen.getByText('Annotate Comments')).toBeInTheDocument();
    });

    it('should show tone selector for comments', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="comment"
          isDelegating={false}
          progress={null}
        />
      );

      expect(screen.getByText('Scholarly')).toBeInTheDocument();
      expect(screen.getByText('Explanatory')).toBeInTheDocument();
    });

    it('should show tone selector for assessments', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="assessment"
          isDelegating={false}
          progress={null}
        />
      );

      expect(screen.getByText('Analytical')).toBeInTheDocument();
      expect(screen.getByText('Critical')).toBeInTheDocument();
    });

    it('should not show tone selector for highlights', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
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

      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
          progress={null}
        />
      );

      const subscription = eventBus.on('mark:delegate-request').subscribe(detectionHandler);

      const annotateButton = screen.getByRole('button', { name: /✨\s*Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        params: expect.objectContaining({ motivation: 'highlighting' }),
      });

      subscription.unsubscribe();
    });

    it('should emit correct motivation for assessment type', async () => {
      const user = userEvent.setup();
      const detectionHandler = vi.fn();

      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="assessment"
          isDelegating={false}
          progress={null}
        />
      );

      const subscription = eventBus.on('mark:delegate-request').subscribe(detectionHandler);

      const annotateButton = screen.getByRole('button', { name: /✨\s*Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        params: expect.objectContaining({ motivation: 'assessing' }),
      });

      subscription.unsubscribe();
    });

    it('should emit correct motivation for comment type', async () => {
      const user = userEvent.setup();
      const detectionHandler = vi.fn();

      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="comment"
          isDelegating={false}
          progress={null}
        />
      );

      const subscription = eventBus.on('mark:delegate-request').subscribe(detectionHandler);

      const annotateButton = screen.getByRole('button', { name: /✨\s*Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        params: expect.objectContaining({ motivation: 'commenting' }),
      });

      subscription.unsubscribe();
    });

    it('should include instructions in event when provided', async () => {
      const user = userEvent.setup();
      const detectionHandler = vi.fn();

      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
          progress={null}
        />
      );

      const subscription = eventBus.on('mark:delegate-request').subscribe(detectionHandler);

      const textarea = screen.getByPlaceholderText('Enter custom instructions...');
      await user.type(textarea, 'Find key concepts');

      const annotateButton = screen.getByRole('button', { name: /✨\s*Annotate/ });
      await user.click(annotateButton);

      expect(detectionHandler).toHaveBeenCalledWith({
        params: {
          motivation: 'highlighting',
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
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
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
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
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
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={false}
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
    it('should handle progress without a message', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={true}
          progress={{
            percentage: 0,
          }}
        />
      );

      // Renders the progress section with the translated status line — the
      // wire carries a code (or nothing), never a sentence to fall back on.
      const progressDiv = document.querySelector('.semiont-delegate-progress');
      expect(progressDiv).toBeInTheDocument();
    });

    it('should handle progress with empty requestParams array', () => {
      renderWithProviders(
        <DelegateSection
          session={session}
          annotationType="highlight"
          isDelegating={true}
          progress={{
            percentage: 0,
            requestParams: [],
          }}
        />
      );

      expect(screen.queryByTestId('semiont-delegate-params')).not.toBeInTheDocument();
    });
  });
});
