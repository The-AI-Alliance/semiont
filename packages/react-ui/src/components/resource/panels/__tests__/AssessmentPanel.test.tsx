import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { AssessmentPanel } from '../AssessmentPanel';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../../contexts/EventBusContext';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

// Composition-based event tracker
interface TrackedEvent {
  event: string;
  payload: any;
}

function createEventTracker() {
  const events: TrackedEvent[] = [];

  function EventTrackingWrapper({ children }: { children: React.ReactNode }) {
    const eventBus = useEventBus();

    React.useEffect(() => {
      const handlers: Array<() => void> = [];

      const trackEvent = (eventName: string) => (payload: any) => {
        events.push({ event: eventName, payload });
      };

      const panelEvents = ['annotate:create'] as const;

      panelEvents.forEach(eventName => {
        const handler = trackEvent(eventName);
        const subscription = eventBus.get(eventName).subscribe(handler);
        handlers.push(subscription);
      });

      return () => {
        handlers.forEach(sub => sub.unsubscribe());
      };
    }, [eventBus]);

    return <>{children}</>;
  }

  return {
    EventTrackingWrapper,
    events,
    clear: () => {
      events.length = 0;
    },
  };
}

// Helper to render with EventBusProvider
const renderWithEventBus = (component: React.ReactElement, tracker?: ReturnType<typeof createEventTracker>) => {
  if (tracker) {
    return render(
      <EventBusProvider>
        <tracker.EventTrackingWrapper>
          {component}
        </tracker.EventTrackingWrapper>
      </EventBusProvider>
    );
  }

  return render(
    <EventBusProvider>
      {component}
    </EventBusProvider>
  );
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

// Mock @semiont/api-client utilities
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getTextPositionSelector: vi.fn(),
    getTargetSelector: vi.fn(),
  };
});

// Mock AssessmentEntry component to simplify testing
vi.mock('../AssessmentEntry', () => ({
  AssessmentEntry: ({ assessment, onAssessmentRef }: any) => (
    <div data-testid={`assessment-${assessment.id}`}>
      <div>{assessment.id}</div>
    </div>
  ),
}));

// Mock DetectSection component - it will internally use the mocked useEventBus
// Just render a simplified version
vi.mock('../DetectSection', () => ({
  DetectSection: ({ annotationType, isDetecting }: any) => (
    <div data-testid="detect-section">
      <button>Start Detection</button>
      {isDetecting && <div>Detecting...</div>}
    </div>
  ),
}));

import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';

const mockGetTextPositionSelector = getTextPositionSelector as MockedFunction<typeof getTextPositionSelector>;
const mockGetTargetSelector = getTargetSelector as MockedFunction<typeof getTargetSelector>;

// Test data fixtures
const createMockAssessment = (id: string, start: number, end: number): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id,
  type: 'Annotation',
  motivation: 'assessing',
  creator: {
    name: `user${id}@example.com`,
  },
  created: `2024-01-0${id.slice(-1)}T10:00:00Z`,
  modified: `2024-01-0${id.slice(-1)}T10:00:00Z`,
  target: {
    source: 'resource-1',
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
    annotations: mockAssessments.empty,
    pendingAnnotation: null,
  };

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();

    // Mock scrollIntoView for jsdom
    Element.prototype.scrollIntoView = vi.fn();

    // Mock selector functions to return proper position data
    mockGetTargetSelector.mockImplementation((target: any) => target.selector);
    mockGetTextPositionSelector.mockImplementation((selector: any) => {
      if (selector?.type === 'TextPositionSelector') {
        return selector;
      }
      return null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel header with title and count', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} annotations={mockAssessments.multiple} />);

      expect(screen.getByText(/Assessments/)).toBeInTheDocument();
      expect(screen.getByText(/\(3\)/)).toBeInTheDocument();
    });

    it('should show empty state when no assessments', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} />);

      expect(screen.getByText(/No assessments yet/)).toBeInTheDocument();
    });

    it('should render all assessments', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} annotations={mockAssessments.multiple} />);

      expect(screen.getByTestId('assessment-1')).toBeInTheDocument();
      expect(screen.getByTestId('assessment-2')).toBeInTheDocument();
      expect(screen.getByTestId('assessment-3')).toBeInTheDocument();
    });

    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<AssessmentPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });
  });

  describe('Assessment Sorting', () => {
    it('should sort assessments by position in resource', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} annotations={mockAssessments.multiple} />);

      const assessments = screen.getAllByTestId(/assessment-/);

      // Should be sorted by start position: assessment-2 (0), assessment-1 (50), assessment-3 (100)
      expect(assessments[0]).toHaveAttribute('data-testid', 'assessment-2');
      expect(assessments[1]).toHaveAttribute('data-testid', 'assessment-1');
      expect(assessments[2]).toHaveAttribute('data-testid', 'assessment-3');
    });

    it('should handle assessments without valid selectors', () => {
      mockGetTextPositionSelector.mockReturnValue(null);

      expect(() => {
        renderWithEventBus(<AssessmentPanel {...defaultProps} annotations={mockAssessments.multiple} />);
      }).not.toThrow();
    });
  });

  describe('New Assessment Creation', () => {
    it('should not show new assessment input by default', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} />);

      expect(screen.queryByPlaceholderText(/Type your assessment here/)).not.toBeInTheDocument();
    });

    it('should show new assessment input when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByPlaceholderText(/Type your assessment here/)).toBeInTheDocument();
    });

    it('should display quoted selected text in new assessment area', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text for assessment');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
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
          {...defaultProps}
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
          {...defaultProps}
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
          {...defaultProps}
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
          {...defaultProps}
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
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      expect(textarea).toHaveFocus();
    });

    it('should emit annotate:createevent when save is clicked', async () => {
      const tracker = createEventTracker();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
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
          e.event === 'annotate:create' &&
          e.payload?.motivation === 'assessing' &&
          e.payload?.body?.[0]?.value === 'My assessment'
        )).toBe(true);
      });
    });

    it('should clear textarea after successful save', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
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
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />,
        tracker
      );

      const saveButton = screen.getByText('Save');
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'annotate:create' &&
          e.payload?.motivation === 'assessing' &&
          Array.isArray(e.payload?.body) &&
          e.payload.body.length === 0
        )).toBe(true);
      });
    });

    it('should have proper styling for new assessment area', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      const { container } = renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
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
          {...defaultProps}
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
            {...defaultProps}
            annotations={mockAssessments.single}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Detection Section', () => {
    it('should render DetectSection when annotateMode is true', () => {
      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(screen.getByTestId('detect-section')).toBeInTheDocument();
    });

    it('should not render DetectSection when annotateMode is false', () => {
      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
          annotateMode={false}
        />
      );

      expect(screen.queryByTestId('detect-section')).not.toBeInTheDocument();
    });

    it('should render DetectSection with correct annotationType', () => {
      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      // DetectSection is rendered (mocked component renders the button)
      expect(screen.getByText('Start Detection')).toBeInTheDocument();
    });
  });

  describe('Cancel Functionality', () => {
    it('should show Cancel button when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('should clear textarea when Cancel button is clicked', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      await userEvent.type(textarea, 'My assessment');

      const cancelButton = screen.getByText('Cancel');
      await userEvent.click(cancelButton);

      expect(textarea).toHaveValue('');
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      renderWithEventBus(<AssessmentPanel {...defaultProps} />);

      const heading = screen.getByText(/Assessments/);
      expect(heading).toHaveClass('semiont-panel-header__text');
    });

    it('should have proper textarea attributes for new assessments', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <AssessmentPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const textarea = screen.getByPlaceholderText(/Type your assessment here/);
      expect(textarea).toHaveAttribute('rows', '3');
    });
  });
});
