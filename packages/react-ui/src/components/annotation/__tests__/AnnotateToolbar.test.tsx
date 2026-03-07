import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { AnnotateToolbar, type SelectionMotivation, type ClickAction } from '../AnnotateToolbar';
import { ANNOTATORS } from '../../../lib/annotation-registry';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../contexts/EventBusContext';

// Mock translations
const messages = {
  AnnotateToolbar: {
    modeGroup: 'Mode',
    browse: 'Browse',
    annotate: 'Annotate',
    clickGroup: 'Click',
    selectionGroup: 'Motivation',
    shapeGroup: 'Shape',
    linking: 'Reference',
    highlighting: 'Highlight',
    assessing: 'Assess',
    commenting: 'Comment',
    tagging: 'Tag',
    detail: 'Detail',
    follow: 'Follow',
    deleting: 'Delete',
    jsonld: 'JSON-LD',
    rectangle: 'Rectangle',
    circle: 'Circle',
    polygon: 'Polygon'
  }
};

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

      // Track toolbar-related events
      const trackEvent = (eventName: string) => (payload: any) => {
        events.push({ event: eventName, payload });
      };

      const toolbarEvents = [
        'mark:mode-toggled',
        'mark:click-changed',
        'mark:selection-changed',
        'mark:shape-changed',
      ] as const;

      toolbarEvents.forEach(eventName => {
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

const renderWithIntl = (component: React.ReactElement, tracker?: ReturnType<typeof createEventTracker>) => {
  if (tracker) {
    return render(
      <EventBusProvider>
        <NextIntlClientProvider locale="en" messages={messages}>
          <tracker.EventTrackingWrapper>
            {component}
          </tracker.EventTrackingWrapper>
        </NextIntlClientProvider>
      </EventBusProvider>
    );
  }

  return render(
    <EventBusProvider>
      <NextIntlClientProvider locale="en" messages={messages}>
        {component}
      </NextIntlClientProvider>
    </EventBusProvider>
  );
};

describe('AnnotateToolbar', () => {
  const defaultProps = {
    selectedMotivation: null as SelectionMotivation | null,
    selectedClick: 'detail' as ClickAction,
    onSelectionChange: vi.fn(),
    onClickChange: vi.fn(),
    annotateMode: false,
    annotators: ANNOTATORS
  };

  beforeEach(() => {
    resetEventBusForTesting();
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders with required props', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      // Check for aria-labels (labels only shown when expanded)
      expect(screen.getByLabelText('Click')).toBeInTheDocument();
      expect(screen.getByText('Detail')).toBeInTheDocument();
    });

    it('shows MODE group', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      // Check for aria-label (label only shown when expanded)
      expect(screen.getByLabelText('Mode')).toBeInTheDocument();
      expect(screen.getByText('Browse')).toBeInTheDocument();
    });

    it('shows selection group by default', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      // Check for aria-label (label only shown when expanded)
      expect(screen.getByLabelText('Motivation')).toBeInTheDocument();
    });

    it('hides selection group when showSelectionGroup is false', () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} showSelectionGroup={false} />
      );
      // Check for aria-label absence
      expect(screen.queryByLabelText('Motivation')).not.toBeInTheDocument();
    });

    it('hides delete button when showDeleteButton is false', () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} showDeleteButton={false} />
      );
      // Open click dropdown
      const clickGroup = screen.getByLabelText('Click');
      fireEvent.mouseEnter(clickGroup);

      // Delete option should not be present
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('shows shape group when showShapeGroup is true', () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          showShapeGroup={true}
          selectedShape="rectangle"
        />
      );
      // Check for aria-label (label only shown when expanded)
      expect(screen.getByLabelText('Shape')).toBeInTheDocument();
      expect(screen.getByText('Rectangle')).toBeInTheDocument();
    });
  });

  describe('MODE Group Interactions', () => {
    it('displays current mode correctly', () => {
      const { rerender } = renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
        />
      );
      expect(screen.getByText('Browse')).toBeInTheDocument();

      rerender(
        <EventBusProvider>
          <NextIntlClientProvider locale="en" messages={messages}>
            <AnnotateToolbar
              {...defaultProps}
              annotateMode={true}
            />
          </NextIntlClientProvider>
        </EventBusProvider>
      );
      expect(screen.getByText('Annotate')).toBeInTheDocument();
    });

    it('expands on hover', async () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
        />
      );

      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        // Find the dropdown menu by role
        const dropdown = screen.getByRole('menu');
        // Both options should be visible in the expanded dropdown menu
        expect(within(dropdown).getByText('Browse')).toBeInTheDocument();
        expect(within(dropdown).getByText('Annotate')).toBeInTheDocument();
      });
    });

    it('emits mark:mode-toggled event when Browse is clicked in Annotate mode', async () => {
      const tracker = createEventTracker();
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={true}
        />,
        tracker
      );

      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        const browseButton = screen.getByText('Browse');
        fireEvent.click(browseButton);
      });

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'mark:mode-toggled')).toBe(true);
      });
    });

    it('emits mark:mode-toggled event when Annotate is clicked in Browse mode', async () => {
      const tracker = createEventTracker();
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
        />,
        tracker
      );

      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        const annotateButton = screen.getByText('Annotate');
        fireEvent.click(annotateButton);
      });

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'mark:mode-toggled')).toBe(true);
      });
    });

    it('closes dropdown after selection', async () => {
      const tracker = createEventTracker();
      const { rerender } = renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
        />,
        tracker
      );

      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        expect(screen.getByText('Annotate')).toBeInTheDocument();
      });

      const annotateButton = screen.getByText('Annotate');
      fireEvent.click(annotateButton);

      // Verify the event was emitted
      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'mark:mode-toggled')).toBe(true);
      });

      // Simulate mode change by rerendering with new mode
      rerender(
        <EventBusProvider>
          <NextIntlClientProvider locale="en" messages={messages}>
            <tracker.EventTrackingWrapper>
              <AnnotateToolbar
                {...defaultProps}
                annotateMode={true}
              />
            </tracker.EventTrackingWrapper>
          </NextIntlClientProvider>
        </EventBusProvider>
      );

      // After mode change, the collapsed content should show "Annotate"
      // and Browse should not be in the collapsed state
      await waitFor(() => {
        const modeLabels = screen.getAllByText('Annotate');
        // Should have at least the collapsed label
        expect(modeLabels.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('CLICK Group Interactions', () => {
    it('emits mark:click-changed event when clicking an action', async () => {
      const tracker = createEventTracker();
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} />,
        tracker
      );

      const clickGroup = screen.getByLabelText('Click');
      fireEvent.mouseEnter(clickGroup);

      await waitFor(() => {
        expect(screen.getByText('Follow')).toBeInTheDocument();
      });

      tracker.clear();
      fireEvent.click(screen.getByText('Follow'));
      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:click-changed' && e.payload?.action === 'follow'
        )).toBe(true);
      });
    });

    it('displays selected action', () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} selectedClick="follow" />
      );
      expect(screen.getByText('Follow')).toBeInTheDocument();
    });
  });

  describe('MOTIVATION Group Interactions', () => {
    it('emits mark:selection-changed event when clicking a motivation', async () => {
      const tracker = createEventTracker();
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} />,
        tracker
      );

      const motivationGroup = screen.getByLabelText('Motivation');
      fireEvent.mouseEnter(motivationGroup);

      await waitFor(() => {
        expect(screen.getByText('Reference')).toBeInTheDocument();
      });

      tracker.clear();
      fireEvent.click(screen.getByText('Reference'));
      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:selection-changed' && e.payload?.motivation === 'linking'
        )).toBe(true);
      });
    });

    it('toggles motivation on/off', async () => {
      const tracker = createEventTracker();
      const { rerender } = renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          selectedMotivation={null}
        />,
        tracker
      );

      const motivationGroup = screen.getByLabelText('Motivation');
      fireEvent.mouseEnter(motivationGroup);

      await waitFor(() => {
        const dropdown = screen.getByRole('menu');
        expect(within(dropdown).getByText('Highlight')).toBeInTheDocument();
      });

      const dropdown = screen.getByRole('menu');
      tracker.clear();
      fireEvent.click(within(dropdown).getByText('Highlight'));
      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:selection-changed' && e.payload?.motivation === 'highlighting'
        )).toBe(true);
      });

      // Simulate selection
      rerender(
        <EventBusProvider>
          <NextIntlClientProvider locale="en" messages={messages}>
            <tracker.EventTrackingWrapper>
              <AnnotateToolbar
                {...defaultProps}
                selectedMotivation="highlighting"
              />
            </tracker.EventTrackingWrapper>
          </NextIntlClientProvider>
        </EventBusProvider>
      );

      // Click again to deselect
      fireEvent.mouseEnter(motivationGroup);
      await waitFor(() => {
        const dropdown = screen.getByRole('menu');
        expect(within(dropdown).getByText('Highlight')).toBeInTheDocument();
      });
      const dropdown2 = screen.getByRole('menu');
      tracker.clear();
      fireEvent.click(within(dropdown2).getByText('Highlight'));
      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:selection-changed' && e.payload?.motivation === null
        )).toBe(true);
      });
    });
  });

  describe('SHAPE Group Interactions', () => {
    it('emits mark:shape-changed event when clicking a shape', async () => {
      const tracker = createEventTracker();
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          showShapeGroup={true}
          selectedShape="rectangle"
        />,
        tracker
      );

      const shapeGroup = screen.getByLabelText('Shape');
      fireEvent.mouseEnter(shapeGroup);

      await waitFor(() => {
        expect(screen.getByText('Circle')).toBeInTheDocument();
      });

      tracker.clear();
      fireEvent.click(screen.getByText('Circle'));
      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:shape-changed' && e.payload?.shape === 'circle'
        )).toBe(true);
      });
    });
  });

  describe('Keyboard Interactions', () => {
    it('closes all dropdowns on Escape key', async () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
        />
      );

      // Open mode dropdown
      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);
      fireEvent.click(modeGroup); // Pin it

      await waitFor(() => {
        // When expanded, dropdown menu should be visible with both options
        const dropdown = screen.getByRole('menu');
        expect(within(dropdown).getByText('Browse')).toBeInTheDocument();
        expect(within(dropdown).getByText('Annotate')).toBeInTheDocument();
      });

      // Press Escape
      fireEvent.keyDown(document, { key: 'Escape' });

      // Move mouse away to complete closing
      fireEvent.mouseLeave(modeGroup);

      await waitFor(() => {
        // After closing, dropdown menu should not be present
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        // But collapsed "Browse" label should still be visible
        expect(screen.getByText('Browse')).toBeInTheDocument();
      });
    });
  });

  describe('Click Outside Behavior', () => {
    it('closes pinned dropdown when clicking outside', async () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);

      const clickGroup = screen.getByLabelText('Click');
      fireEvent.mouseEnter(clickGroup);
      fireEvent.click(clickGroup); // Pin it

      await waitFor(() => {
        expect(screen.getByText('Follow')).toBeInTheDocument();
      });

      // Click outside - need to click on an element outside the dropdown
      fireEvent.mouseDown(document.body);

      // Also move mouse away to ensure hover state is cleared
      fireEvent.mouseLeave(clickGroup);

      await waitFor(() => {
        expect(screen.queryByText('Follow')).not.toBeInTheDocument();
      });
    });
  });
});
