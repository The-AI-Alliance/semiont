import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { AnnotateToolbar, type SelectionMotivation, type ClickAction, type ShapeType } from '../AnnotateToolbar';

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

const renderWithIntl = (component: React.ReactElement) => {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {component}
    </NextIntlClientProvider>
  );
};

describe('AnnotateToolbar', () => {
  const defaultProps = {
    selectedMotivation: null as SelectionMotivation | null,
    selectedClick: 'detail' as ClickAction,
    onSelectionChange: jest.fn(),
    onClickChange: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders with required props', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      expect(screen.getByText('Click')).toBeInTheDocument();
      expect(screen.getByText('Detail')).toBeInTheDocument();
    });

    it('shows MODE group when onAnnotateModeToggle is provided', () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
          onAnnotateModeToggle={jest.fn()}
        />
      );
      expect(screen.getByText('Mode')).toBeInTheDocument();
      expect(screen.getByText('Browse')).toBeInTheDocument();
    });

    it('hides MODE group when onAnnotateModeToggle is not provided', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      expect(screen.queryByText('Mode')).not.toBeInTheDocument();
    });

    it('shows selection group by default', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      expect(screen.getByText('Motivation')).toBeInTheDocument();
    });

    it('hides selection group when showSelectionGroup is false', () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} showSelectionGroup={false} />
      );
      expect(screen.queryByText('Motivation')).not.toBeInTheDocument();
    });

    it('hides delete button when showDeleteButton is false', () => {
      const { container } = renderWithIntl(
        <AnnotateToolbar {...defaultProps} showDeleteButton={false} />
      );
      // Open click dropdown
      const clickGroup = screen.getByText('Click');
      fireEvent.mouseEnter(clickGroup.parentElement!);

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
      expect(screen.getByText('Shape')).toBeInTheDocument();
      expect(screen.getByText('Rectangle')).toBeInTheDocument();
    });
  });

  describe('MODE Group Interactions', () => {
    it('displays current mode correctly', () => {
      const { rerender } = renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
          onAnnotateModeToggle={jest.fn()}
        />
      );
      expect(screen.getByText('Browse')).toBeInTheDocument();

      rerender(
        <NextIntlClientProvider locale="en" messages={messages}>
          <AnnotateToolbar
            {...defaultProps}
            annotateMode={true}
            onAnnotateModeToggle={jest.fn()}
          />
        </NextIntlClientProvider>
      );
      expect(screen.getByText('Annotate')).toBeInTheDocument();
    });

    it('expands on hover', async () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
          onAnnotateModeToggle={jest.fn()}
        />
      );

      const modeGroup = screen.getByText('Mode').parentElement!;
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        // Both options should be visible when expanded
        const browseOptions = screen.getAllByText('Browse');
        const annotateOptions = screen.getAllByText('Annotate');
        expect(browseOptions.length).toBeGreaterThan(1);
        expect(annotateOptions.length).toBeGreaterThan(0);
      });
    });

    it('calls onAnnotateModeToggle when Browse is clicked in Annotate mode', async () => {
      const handleToggle = jest.fn();
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={true}
          onAnnotateModeToggle={handleToggle}
        />
      );

      const modeGroup = screen.getByText('Mode').parentElement!;
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        const browseButtons = screen.getAllByText('Browse');
        const expandedBrowse = browseButtons.find(el =>
          el.closest('.absolute') !== null
        );
        if (expandedBrowse) {
          fireEvent.click(expandedBrowse);
        }
      });

      expect(handleToggle).toHaveBeenCalledTimes(1);
    });

    it('calls onAnnotateModeToggle when Annotate is clicked in Browse mode', async () => {
      const handleToggle = jest.fn();
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
          onAnnotateModeToggle={handleToggle}
        />
      );

      const modeGroup = screen.getByText('Mode').parentElement!;
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        const annotateButtons = screen.getAllByText('Annotate');
        const expandedAnnotate = annotateButtons.find(el =>
          el.closest('.absolute') !== null
        );
        if (expandedAnnotate) {
          fireEvent.click(expandedAnnotate);
        }
      });

      expect(handleToggle).toHaveBeenCalledTimes(1);
    });

    it('closes dropdown after selection', async () => {
      const handleToggle = jest.fn();
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
          onAnnotateModeToggle={handleToggle}
        />
      );

      const modeGroup = screen.getByText('Mode').parentElement!;
      fireEvent.mouseEnter(modeGroup);

      await waitFor(() => {
        const annotateButtons = screen.getAllByText('Annotate');
        expect(annotateButtons.length).toBeGreaterThan(1);
      });

      const annotateButtons = screen.getAllByText('Annotate');
      const expandedAnnotate = annotateButtons.find(el =>
        el.closest('.absolute') !== null
      );
      if (expandedAnnotate) {
        fireEvent.click(expandedAnnotate);
      }

      // Move mouse away
      fireEvent.mouseLeave(modeGroup);

      await waitFor(() => {
        const remainingButtons = screen.getAllByText('Annotate');
        // Only collapsed version should remain
        expect(remainingButtons.length).toBe(1);
      });
    });
  });

  describe('CLICK Group Interactions', () => {
    it('calls onClickChange when clicking an action', async () => {
      const handleChange = jest.fn();
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} onClickChange={handleChange} />
      );

      const clickGroup = screen.getByText('Click').parentElement!;
      fireEvent.mouseEnter(clickGroup);

      await waitFor(() => {
        expect(screen.getByText('Follow')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Follow'));
      expect(handleChange).toHaveBeenCalledWith('follow');
    });

    it('displays selected action', () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} selectedClick="follow" />
      );
      expect(screen.getByText('Follow')).toBeInTheDocument();
    });
  });

  describe('MOTIVATION Group Interactions', () => {
    it('calls onSelectionChange when clicking a motivation', async () => {
      const handleChange = jest.fn();
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} onSelectionChange={handleChange} />
      );

      const motivationGroup = screen.getByText('Motivation').parentElement!;
      fireEvent.mouseEnter(motivationGroup);

      await waitFor(() => {
        expect(screen.getByText('Reference')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Reference'));
      expect(handleChange).toHaveBeenCalledWith('linking');
    });

    it('toggles motivation on/off', async () => {
      const handleChange = jest.fn();
      const { rerender } = renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          selectedMotivation={null}
          onSelectionChange={handleChange}
        />
      );

      const motivationGroup = screen.getByText('Motivation').parentElement!;
      fireEvent.mouseEnter(motivationGroup);

      await waitFor(() => {
        expect(screen.getByText('Highlight')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Highlight'));
      expect(handleChange).toHaveBeenCalledWith('highlighting');

      // Simulate selection
      rerender(
        <NextIntlClientProvider locale="en" messages={messages}>
          <AnnotateToolbar
            {...defaultProps}
            selectedMotivation="highlighting"
            onSelectionChange={handleChange}
          />
        </NextIntlClientProvider>
      );

      // Click again to deselect
      fireEvent.mouseEnter(motivationGroup);
      await waitFor(() => {
        expect(screen.getByText('Highlight')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Highlight'));
      expect(handleChange).toHaveBeenCalledWith(null);
    });
  });

  describe('SHAPE Group Interactions', () => {
    it('calls onShapeChange when clicking a shape', async () => {
      const handleChange = jest.fn();
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          showShapeGroup={true}
          selectedShape="rectangle"
          onShapeChange={handleChange}
        />
      );

      const shapeGroup = screen.getByText('Shape').parentElement!;
      fireEvent.mouseEnter(shapeGroup);

      await waitFor(() => {
        expect(screen.getByText('Circle')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Circle'));
      expect(handleChange).toHaveBeenCalledWith('circle');
    });
  });

  describe('Keyboard Interactions', () => {
    it('closes all dropdowns on Escape key', async () => {
      renderWithIntl(
        <AnnotateToolbar
          {...defaultProps}
          annotateMode={false}
          onAnnotateModeToggle={jest.fn()}
        />
      );

      // Open mode dropdown
      const modeGroup = screen.getByText('Mode').parentElement!;
      fireEvent.mouseEnter(modeGroup);
      fireEvent.click(modeGroup); // Pin it

      await waitFor(() => {
        const annotateButtons = screen.getAllByText('Annotate');
        expect(annotateButtons.length).toBeGreaterThan(1);
      });

      // Press Escape
      fireEvent.keyDown(document, { key: 'Escape' });

      // Move mouse away to complete closing
      fireEvent.mouseLeave(modeGroup);

      await waitFor(() => {
        const remainingButtons = screen.getAllByText('Browse');
        expect(remainingButtons.length).toBe(1);
      });
    });
  });

  describe('Click Outside Behavior', () => {
    it('closes pinned dropdown when clicking outside', async () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);

      const clickGroup = screen.getByText('Click').parentElement!;
      fireEvent.mouseEnter(clickGroup);
      fireEvent.click(clickGroup); // Pin it

      await waitFor(() => {
        expect(screen.getByText('Follow')).toBeInTheDocument();
      });

      // Click outside
      fireEvent.mouseDown(document.body);

      await waitFor(() => {
        expect(screen.queryByText('Follow')).not.toBeInTheDocument();
      });
    });
  });
});
