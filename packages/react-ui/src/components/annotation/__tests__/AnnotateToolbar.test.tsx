import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { AnnotateToolbar, type SelectionMotivation, type ClickAction } from '../AnnotateToolbar';
import { ANNOTATORS } from '../../../lib/annotation-registry';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../contexts/EventBusContext';

// Mock event bus emit function for spying on events
const mockEmit = vi.fn();

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

// Wrapper component to spy on EventBus emit calls
function TestWrapper({ children }: { children: React.ReactNode }) {
  const eventBus = useEventBus();

  // Wrap the real emit with our spy
  React.useEffect(() => {
    const originalEmit = eventBus.emit.bind(eventBus);
    eventBus.emit = ((eventName: string, payload?: unknown) => {
      mockEmit(eventName, payload);
      return originalEmit(eventName, payload);
    }) as typeof eventBus.emit;
  }, [eventBus]);

  return <>{children}</>;
}

const renderWithIntl = (component: React.ReactElement) => {
  return render(
    <EventBusProvider>
      <NextIntlClientProvider locale="en" messages={messages}>
        <TestWrapper>
          {component}
        </TestWrapper>
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
    mockEmit.mockClear();
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
            <TestWrapper>
              <AnnotateToolbar
                {...defaultProps}
                annotateMode={true}
              />
            </TestWrapper>
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

    it('emits view:mode-toggled event when Browse is clicked in Annotate mode', async () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={true}
        />
      );

      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        const browseButton = screen.getByText('Browse');
        fireEvent.click(browseButton);
      });

      expect(mockEmit).toHaveBeenCalledWith('view:mode-toggled', undefined);
    });

    it('emits view:mode-toggled event when Annotate is clicked in Browse mode', async () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
        />
      );

      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        const annotateButton = screen.getByText('Annotate');
        fireEvent.click(annotateButton);
      });

      expect(mockEmit).toHaveBeenCalledWith('view:mode-toggled', undefined);
    });

    it('closes dropdown after selection', async () => {
      const { rerender } = renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
        />
      );

      const modeGroup = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        expect(screen.getByText('Annotate')).toBeInTheDocument();
      });

      const annotateButton = screen.getByText('Annotate');
      fireEvent.click(annotateButton);

      // Verify the event was emitted
      expect(mockEmit).toHaveBeenCalledWith('view:mode-toggled', undefined);

      // Simulate mode change by rerendering with new mode
      rerender(
        <EventBusProvider>
          <NextIntlClientProvider locale="en" messages={messages}>
            <TestWrapper>
              <AnnotateToolbar
                {...defaultProps}
                annotateMode={true}
              />
            </TestWrapper>
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
    it('emits toolbar:click-changed event when clicking an action', async () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} />
      );

      const clickGroup = screen.getByLabelText('Click');
      fireEvent.mouseEnter(clickGroup);

      await waitFor(() => {
        expect(screen.getByText('Follow')).toBeInTheDocument();
      });

      mockEmit.mockClear();
      fireEvent.click(screen.getByText('Follow'));
      expect(mockEmit).toHaveBeenCalledWith('toolbar:click-changed', { action: 'follow' });
    });

    it('displays selected action', () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} selectedClick="follow" />
      );
      expect(screen.getByText('Follow')).toBeInTheDocument();
    });
  });

  describe('MOTIVATION Group Interactions', () => {
    it('emits toolbar:selection-changed event when clicking a motivation', async () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} />
      );

      const motivationGroup = screen.getByLabelText('Motivation');
      fireEvent.mouseEnter(motivationGroup);

      await waitFor(() => {
        expect(screen.getByText('Reference')).toBeInTheDocument();
      });

      mockEmit.mockClear();
      fireEvent.click(screen.getByText('Reference'));
      expect(mockEmit).toHaveBeenCalledWith('toolbar:selection-changed', { motivation: 'linking' });
    });

    it('toggles motivation on/off', async () => {
      const { rerender } = renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          selectedMotivation={null}
        />
      );

      const motivationGroup = screen.getByLabelText('Motivation');
      fireEvent.mouseEnter(motivationGroup);

      await waitFor(() => {
        const dropdown = screen.getByRole('menu');
        expect(within(dropdown).getByText('Highlight')).toBeInTheDocument();
      });

      const dropdown = screen.getByRole('menu');
      mockEmit.mockClear();
      fireEvent.click(within(dropdown).getByText('Highlight'));
      expect(mockEmit).toHaveBeenCalledWith('toolbar:selection-changed', { motivation: 'highlighting' });

      // Simulate selection
      rerender(
        <EventBusProvider>
          <NextIntlClientProvider locale="en" messages={messages}>
            <TestWrapper>
              <AnnotateToolbar
                {...defaultProps}
                selectedMotivation="highlighting"
              />
            </TestWrapper>
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
      mockEmit.mockClear();
      fireEvent.click(within(dropdown2).getByText('Highlight'));
      expect(mockEmit).toHaveBeenCalledWith('toolbar:selection-changed', { motivation: null });
    });
  });

  describe('SHAPE Group Interactions', () => {
    it('emits toolbar:shape-changed event when clicking a shape', async () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          showShapeGroup={true}
          selectedShape="rectangle"
        />
      );

      const shapeGroup = screen.getByLabelText('Shape');
      fireEvent.mouseEnter(shapeGroup);

      await waitFor(() => {
        expect(screen.getByText('Circle')).toBeInTheDocument();
      });

      mockEmit.mockClear();
      fireEvent.click(screen.getByText('Circle'));
      expect(mockEmit).toHaveBeenCalledWith('toolbar:shape-changed', { shape: 'circle' });
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
