/**
 * AnnotateToolbar — purely presentational (TOOLBAR-PREFS-AS-PROPS).
 *
 * The bar renders the given values for the given `parts` and reports choices via
 * the on*Change callbacks. No session, no bus events, no storage — those died with
 * the preference channels; owners (viewer instances / hosts) apply the values.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import '@testing-library/jest-dom';
import { AnnotateToolbar, type SelectionMotivation, type ClickAction } from '../AnnotateToolbar';
import { ANNOTATORS } from '../../../lib/annotation-registry';
import { TranslationProvider } from '../../../contexts/TranslationContext';
import type { TranslationManager } from '../../../types/TranslationManager';

const messages: Record<string, Record<string, string>> = {
  AnnotateToolbar: {
    modeGroup: 'Mode',
    browse: 'Browse',
    annotate: 'Annotate',
    clickGroup: 'Click',
    selectionGroup: 'Motivation',
    shapeGroup: 'Shape',
    none: 'None',
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
    polygon: 'Polygon',
  },
};

const translationManager: TranslationManager = {
  t: (namespace, key) => messages[namespace]?.[key] ?? `${namespace}.${key}`,
};

const renderWithIntl = (component: React.ReactElement) =>
  render(
    <TranslationProvider translationManager={translationManager}>
      {component}
    </TranslationProvider>,
  );

/** Hover a dropdown group open and click an option in its menu. */
async function pick(group: string, option: string) {
  const trigger = screen.getByLabelText(group);
  fireEvent.mouseEnter(trigger.parentElement!);
  await waitFor(() => {
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText(option));
  });
}

describe('AnnotateToolbar', () => {
  const defaultProps = {
    selectedMotivation: null as SelectionMotivation | null,
    selectedClick: 'detail' as ClickAction,
    annotateMode: false,
    annotators: ANNOTATORS,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders the click group with the selected action', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      expect(screen.getByLabelText('Click')).toBeInTheDocument();
      expect(screen.getByText('Detail')).toBeInTheDocument();
    });

    it('shows the MODE group with the current mode', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      expect(screen.getByLabelText('Mode')).toBeInTheDocument();
      expect(screen.getByText('Browse')).toBeInTheDocument();
    });

    it('shows the selection group by default (parts default: all)', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      expect(screen.getByLabelText('Motivation')).toBeInTheDocument();
    });

    it('hides the delete option when showDeleteButton is false', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} showDeleteButton={false} />);
      const clickGroup = screen.getByLabelText('Click');
      fireEvent.mouseEnter(clickGroup.parentElement!);
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('displays the given mode across rerenders (value comes from the owner)', () => {
      const { rerender } = renderWithIntl(<AnnotateToolbar {...defaultProps} annotateMode={false} />);
      expect(screen.getByText('Browse')).toBeInTheDocument();
      rerender(
        <TranslationProvider translationManager={translationManager}>
          <AnnotateToolbar {...defaultProps} annotateMode={true} />
        </TranslationProvider>,
      );
      expect(screen.getByText('Annotate')).toBeInTheDocument();
    });
  });

  describe('parts composition', () => {
    it("parts={['shape']} renders exactly the shape group", () => {
      const { container } = renderWithIntl(
        <AnnotateToolbar {...defaultProps} parts={['shape']} selectedShape="rectangle" mediaType="image/png" />,
      );
      expect(screen.getByLabelText('Shape')).toBeInTheDocument();
      expect(screen.queryByLabelText('Click')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Mode')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Motivation')).not.toBeInTheDocument();
      // A lone part renders no separators
      expect(container.querySelector('.semiont-toolbar-separator')).toBeNull();
    });

    it("parts={['clickAction','mode']} renders those two with one separator", () => {
      const { container } = renderWithIntl(
        <AnnotateToolbar {...defaultProps} parts={['clickAction', 'mode']} />,
      );
      expect(screen.getByLabelText('Click')).toBeInTheDocument();
      expect(screen.getByLabelText('Mode')).toBeInTheDocument();
      expect(screen.queryByLabelText('Motivation')).not.toBeInTheDocument();
      expect(container.querySelectorAll('.semiont-toolbar-separator')).toHaveLength(1);
    });

    it('the default renders all four groups (shape media-gated: none for PDF beyond rectangle)', () => {
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} selectedShape="rectangle" mediaType="image/png" />,
      );
      expect(screen.getByLabelText('Click')).toBeInTheDocument();
      expect(screen.getByLabelText('Mode')).toBeInTheDocument();
      expect(screen.getByLabelText('Motivation')).toBeInTheDocument();
      expect(screen.getByLabelText('Shape')).toBeInTheDocument();
    });
  });

  describe('Mode control', () => {
    it('reports the next mode via onModeChange when switching to Annotate', async () => {
      const onModeChange = vi.fn();
      renderWithIntl(<AnnotateToolbar {...defaultProps} annotateMode={false} onModeChange={onModeChange} />);
      await pick('Mode', 'Annotate');
      expect(onModeChange).toHaveBeenCalledWith(true);
    });

    it('reports false when switching back to Browse from annotate mode', async () => {
      const onModeChange = vi.fn();
      renderWithIntl(<AnnotateToolbar {...defaultProps} annotateMode={true} onModeChange={onModeChange} />);
      await pick('Mode', 'Browse');
      expect(onModeChange).toHaveBeenCalledWith(false);
    });

    it('clicking the CURRENT mode reports nothing', async () => {
      const onModeChange = vi.fn();
      renderWithIntl(<AnnotateToolbar {...defaultProps} annotateMode={false} onModeChange={onModeChange} />);
      const trigger = screen.getByLabelText('Mode');
      fireEvent.mouseEnter(trigger.parentElement!);
      await waitFor(() => {
        const menu = screen.getByRole('menu');
        fireEvent.click(within(menu).getByText('Browse')); // already in browse
      });
      expect(onModeChange).not.toHaveBeenCalled();
    });
  });

  describe('Click-action control', () => {
    it('reports the chosen action via onClickActionChange', async () => {
      const onClickActionChange = vi.fn();
      renderWithIntl(<AnnotateToolbar {...defaultProps} onClickActionChange={onClickActionChange} />);
      await pick('Click', 'Follow');
      expect(onClickActionChange).toHaveBeenCalledWith('follow');
    });

    it('displays the selected action from props', () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} selectedClick="jsonld" />);
      expect(screen.getByText('JSON-LD')).toBeInTheDocument();
    });
  });

  describe('Selection control', () => {
    it('reports the chosen motivation', async () => {
      const onSelectionChange = vi.fn();
      renderWithIntl(<AnnotateToolbar {...defaultProps} onSelectionChange={onSelectionChange} />);
      await pick('Motivation', 'Highlight');
      expect(onSelectionChange).toHaveBeenCalledWith('highlighting');
    });

    it('re-picking the current motivation reports null (toggle off)', async () => {
      const onSelectionChange = vi.fn();
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} selectedMotivation="highlighting" onSelectionChange={onSelectionChange} />,
      );
      await pick('Motivation', 'Highlight');
      expect(onSelectionChange).toHaveBeenCalledWith(null);
    });

    it('picking None reports null', async () => {
      const onSelectionChange = vi.fn();
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} selectedMotivation="linking" onSelectionChange={onSelectionChange} />,
      );
      await pick('Motivation', 'None');
      expect(onSelectionChange).toHaveBeenCalledWith(null);
    });
  });

  describe('Shape control', () => {
    it('reports the chosen shape', async () => {
      const onShapeChange = vi.fn();
      renderWithIntl(
        <AnnotateToolbar {...defaultProps} parts={['shape']} selectedShape="rectangle"
          mediaType="image/png" onShapeChange={onShapeChange} />,
      );
      await pick('Shape', 'Circle');
      expect(onShapeChange).toHaveBeenCalledWith('circle');
    });
  });

  describe('Dropdown behavior', () => {
    it('closes all dropdowns on Escape', async () => {
      renderWithIntl(<AnnotateToolbar {...defaultProps} />);
      const trigger = screen.getByLabelText('Mode');
      fireEvent.click(trigger); // pin open
      await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.mouseLeave(trigger.parentElement!);
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });
  });
});
