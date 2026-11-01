import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { AssessmentPanel } from '../AssessmentPanel';
import { FrameRefusal, type EventBus, type EventMap } from '@semiont/core';
import type { AssessmentEntry } from '../AssessmentEntry';
import type { DelegateSection } from '../DelegateSection';
import { createMarkStateUnit, type MarkStateUnit, type SemiontSession } from '@semiont/sdk';
import { createTestSemiontWrapper } from '../../../../test-utils';

import type { Annotation, AnnotationId } from '@semiont/core';

// Composition-based event tracker
interface TrackedEvent {
  event: string;
  payload: EventMap['mark:submit'];
}

function createEventTracker() {
  const events: TrackedEvent[] = [];
  return {
    events,
    clear: () => { events.length = 0; },
    _attach(eventBus: EventBus) {
      const panelEvents = ['mark:submit'] as const;
      panelEvents.forEach((eventName) => {
        eventBus.on(eventName).subscribe((payload) => {
          // Nothing bridges into this test's bus: a refusal on it is the test's own fault.
          if (payload instanceof FrameRefusal) throw new Error(`refused: ${payload.channel} lacks ${payload.lacks}`);
          events.push({ event: eventName, payload });
        });
      });
    },
  };
}

// Per-test session/bus/wrapper — created in beforeEach (a module-scope
// factory call would hand tests a client that test-utils disposes after
// the first test). The `session` passed as a prop below and the `eventBus`
// the tracker subscribes come from the SAME factory call.
let session: SemiontSession;
let mark: MarkStateUnit;
let eventBus: EventBus;
let SemiontWrapper: React.ComponentType<{ children: React.ReactNode }>;

const renderWithEventBus = (component: React.ReactElement, tracker?: ReturnType<typeof createEventTracker>) => {
  if (tracker) tracker._attach(eventBus);
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  return render(component, { wrapper: Wrapper });
};

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      title: 'Assessments',
      noAssessments: 'No assessments yet. Select text to add an assessment.',
      assessmentPlaceholder: 'Type your assessment here...',
      save: 'Save',
      cancel: 'Cancel',
      fragmentSelected: 'Fragment selected',
    };
    return translations[key] || key;
  }),
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock @semiont/http-transport utilities
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
  return {
    ...actual,
    getTextPositionSelector: vi.fn(),
    getTargetSelector: vi.fn(),
  };
});

// Mock AssessmentEntry component to simplify testing
vi.mock('../AssessmentEntry', () => ({
  AssessmentEntry: ({ assessment }: React.ComponentProps<typeof AssessmentEntry>) => (
    <div data-testid={`assessment-${assessment.id}`}>
      <div>{assessment.id}</div>
    </div>
  ),
}));

// Mock DelegateSection component — just render a simplified version.
vi.mock('../DelegateSection', () => ({
  DelegateSection: ({ isDelegating }: React.ComponentProps<typeof DelegateSection>) => (
    <div data-testid="detect-section">
      <button>Start Detection</button>
      {isDelegating && <div>Detecting...</div>}
    </div>
  ),
}));

import { getTextPositionSelector, getTargetSelector, resourceId } from '@semiont/core';
const mockGetTextPositionSelector = getTextPositionSelector as MockedFunction<typeof getTextPositionSelector>;
const mockGetTargetSelector = getTargetSelector as MockedFunction<typeof getTargetSelector>;

// Test data fixtures
const createMockAssessment = (id: string, start: number, end: number): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: id as AnnotationId,
  type: 'Annotation',
  motivation: 'assessing',
  creator: {
    '@type': 'Person',
    name: `user${id}@example.com`,
  },
  created: `2024-01-0${id.slice(-1)}T10:00:00Z`,
  modified: `2024-01-0${id.slice(-1)}T10:00:00Z`,
  target: {
    source: resourceId('resource-1'),
    selector: {
      type: 'TextPositionSelector',
      start,
      end,
    },
  },
  body: [
    {
      type: 'TextualBody',
      value: `Assessment ${id}`,
      purpose: 'assessing',
    },
  ],
});

const mockAssessments = {
  empty: [],
  single: [createMockAssessment('1', 0, 10)],
  multiple: [
    createMockAssessment('1', 50, 60),  // Middle position
    createMockAssessment('2', 0, 10),   // First position
    createMockAssessment('3', 100, 110), // Last position
  ],
};

// Helper to create pending annotation
const createPendingAnnotation = (exact: string) => ({
  motivation: 'assessing' as const,
  selector: {
    type: 'TextQuoteSelector' as const,
    exact,
  },
});

describe('AssessmentPanel Component', () => {
  const defaultProps = {
    resourceId: resourceId('res-1'),
    annotations: mockAssessments.empty,
    pendingAnnotation: null,
    jobId: null,
    cancelled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    ({ session, eventBus, SemiontWrapper } = createTestSemiontWrapper());
    mark = createMarkStateUnit(session.client, resourceId('res-1'));

    // Mock scrollIntoView for jsdom
    Element.prototype.scrollIntoView = vi.fn();

    // Mock selector functions to return proper position data
    mockGetTargetSelector.mockImplementation((target) => (typeof target === 'string' ? undefined : target.selector));
    mockGetTextPositionSelector.mockImplementation((selector) => {
      if (selector !== undefined && !Array.isArray(selector) && selector.type === 'TextPositionSelector') {
        return selector;
      }
      return null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mark.dispose();
  });

  describe('Rendering', () => {
    it('should render panel header with title and count', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} annotations={mockAssessments.multiple} />);

      expect(screen.getByText(/Assessments/)).toBeInTheDocument();
      expect(screen.getByText(/\(3\)/)).toBeInTheDocument();
    });

    it('should show empty state when no assessments', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} />);

      expect(screen.getByText(/No assessments yet/)).toBeInTheDocument();
    });

    it('should render all assessments', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} annotations={mockAssessments.multiple} />);

      expect(screen.getByTestId('assessment-1')).toBeInTheDocument();
      expect(screen.getByTestId('assessment-2')).toBeInTheDocument();
      expect(screen.getByTestId('assessment-3')).toBeInTheDocument();
    });

    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });
  });

  describe('Assessment Sorting', () => {
    it('should sort assessments by position in resource', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} annotations={mockAssessments.multiple} />);

      const assessments = screen.getAllByTestId(/assessment-/);

      // Should be sorted by start position: assessment-2 (0), assessment-1 (50), assessment-3 (100)
      expect(assessments[0]).toHaveAttribute('data-testid', 'assessment-2');
      expect(assessments[1]).toHaveAttribute('data-testid', 'assessment-1');
      expect(assessments[2]).toHaveAttribute('data-testid', 'assessment-3');
    });

    it('should handle assessments without valid selectors', () => {
      mockGetTextPositionSelector.mockReturnValue(null);

      expect(() => {
        renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} annotations={mockAssessments.multiple} />);
      }).not.toThrow();
    });
  });

  describe('New Assessment Creation', () => {
    it('should not show new assessment input by default', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} />);

      expect(screen.queryByPlaceholderText(/Type your assessment here/)).not.toBeInTheDocument();
    });

    it('should show new assessment input when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByPlaceholderText(/Type your assessment here/)).toBeInTheDocument();
    });

    it('should display quoted selected text in new assessment area', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text for assessment');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(/"Selected text for assessment"/)).toBeInTheDocument();
    });

    it('should truncate long selected text at 100 characters', () => {
      const longText = 'A'.repeat(150);
      const pendingAnnotation = createPendingAnnotation(longText);

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(new RegExp(`"${'A'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should allow typing in new assessment textarea', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      await userEvent.type(textarea, 'My assessment');

      expect(textarea).toHaveValue('My assessment');
    });

    it('should show character count', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText('0/2000')).toBeInTheDocument();

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      await userEvent.type(textarea, 'Test');

      expect(screen.getByText('4/2000')).toBeInTheDocument();
    });

    it('should enforce maxLength of 2000 characters', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/) as HTMLTextAreaElement;
      expect(textarea).toHaveAttribute('maxLength', '2000');
    });

    it('should auto-focus new assessment textarea', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      expect(textarea).toHaveFocus();
    });

    it('should emit mark:submitevent when save is clicked', async () => {
      const tracker = createEventTracker();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />,
        tracker
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      await userEvent.type(textarea, 'My assessment');

      const saveButton = screen.getByText('Save');
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:submit' &&
          e.payload.motivation === 'assessing' &&
          e.payload.body !== undefined &&
          !Array.isArray(e.payload.body) &&
          e.payload.body.type === 'TextualBody' &&
          e.payload.body.value === 'My assessment'
        )).toBe(true);
      });
    });

    it('should clear textarea after successful save', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      await userEvent.type(textarea, 'My assessment');
      await userEvent.click(screen.getByText('Save'));

      expect(textarea).toHaveValue('');
    });

    it('should emit event when saving with empty text (text is optional for assessments)', async () => {
      const tracker = createEventTracker();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />,
        tracker
      );

      const saveButton = screen.getByText('Save');
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:submit' &&
          e.payload?.motivation === 'assessing' &&
          e.payload?.body === undefined
        )).toBe(true);
      });
    });

    it('should have proper styling for new assessment area', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      const { container } = renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const newAssessmentArea = container.querySelector('.semiont-annotation-prompt');
      expect(newAssessmentArea).toBeInTheDocument();
      expect(newAssessmentArea).toHaveAttribute('data-type', 'assessment');
    });
  });

  describe('Assessment Interactions', () => {
    it('should render assessment entries', () => {
      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          annotations={mockAssessments.single}
        />
      );

      const assessment = screen.getByTestId('assessment-1');
      expect(assessment).toBeInTheDocument();
    });
  });

  describe('Assessment Hover Behavior', () => {
    it('should render without errors', () => {
      expect(() => {
        renderWithEventBus(
          <AssessmentPanel
            {...defaultProps} session={session} mark={mark}
            annotations={mockAssessments.single}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Detection Section', () => {
    it('should render DelegateSection when annotateMode is true', () => {
      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          annotateMode={true}
        />
      );

      expect(screen.getByTestId('detect-section')).toBeInTheDocument();
    });

    it('should not render DelegateSection when annotateMode is false', () => {
      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          annotateMode={false}
        />
      );

      expect(screen.queryByTestId('detect-section')).not.toBeInTheDocument();
    });

    it('should render DelegateSection with correct annotationType', () => {
      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          annotateMode={true}
        />
      );

      // DelegateSection is rendered (mocked component renders the button)
      expect(screen.getByText('Start Detection')).toBeInTheDocument();
    });
  });

  describe('Cancel Functionality', () => {
    it('should show Cancel button when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('Cancel drops the pending annotation and clears the textarea', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');
      const cancelPending = vi.spyOn(mark, 'cancelPending');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      await userEvent.type(textarea, 'My assessment');

      const cancelButton = screen.getByText('Cancel');
      await userEvent.click(cancelButton);

      expect(cancelPending).toHaveBeenCalledOnce();
      expect(textarea).toHaveValue('');
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} session={session} mark={mark} />);

      const heading = screen.getByText(/Assessments/);
      expect(heading).toHaveClass('semiont-panel-header__text');
    });

    it('should have proper textarea attributes for new assessments', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps} session={session} mark={mark}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      expect(textarea).toHaveAttribute('rows', '3');
    });
  });
});
