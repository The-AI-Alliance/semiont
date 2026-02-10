import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { TaggingPanel } from '../TaggingPanel';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

// Mock MakeMeaningEventBusContext
vi.mock('../../../../contexts/MakeMeaningEventBusContext', () => ({
  useMakeMeaningEvents: vi.fn(() => ({
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
}));

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      title: 'Tags',
      noTags: 'No tags yet. Select text to add a tag.',
      createTagForSelection: 'Create tag for selection',
      selectSchema: 'Select schema',
      selectCategory: 'Select category',
      selectCategories: 'Select categories',
      chooseCategory: 'Choose a category',
      schemaLegal: 'Legal (IRAC)',
      schemaScientific: 'Scientific (IMRAD)',
      schemaArgument: 'Argument',
      detectTags: 'Detect Tags',
      detect: 'Detect',
      cancel: 'Cancel',
      fragmentSelected: 'Fragment selected',
      selectAll: 'Select All',
      deselectAll: 'Deselect All',
      categoriesSelected: '{count} categories selected',
      categoryIssue: 'Issue',
      categoryRule: 'Rule',
      categoryApplication: 'Application',
      categoryConclusion: 'Conclusion',
    };
    let result = translations[key] || key;
    if (params?.count !== undefined) {
      result = result.replace('{count}', String(params.count));
    }
    return result;
  }),
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

// Mock TagEntry component to simplify testing
vi.mock('../TagEntry', () => ({
  TagEntry: ({ tag, onClick, onTagRef, onTagHover }: any) => (
    <div
      data-testid={`tag-${tag.id}`}
      onClick={() => onClick()}
    >
      <button
        onMouseEnter={() => onTagHover?.(tag.id)}
        onMouseLeave={() => onTagHover?.(null)}
      >
        Hover
      </button>
      <div>{tag.id}</div>
    </div>
  ),
}));

// Mock tag schemas
vi.mock('../../../../lib/tag-schemas', () => ({
  getAllTagSchemas: vi.fn(() => [
    {
      id: 'legal-irac',
      name: 'Legal (IRAC)',
      description: 'Issue, Rule, Application, Conclusion framework for legal analysis',
      tags: [
        { name: 'Issue', description: 'Legal question to be resolved', color: '#3b82f6' },
        { name: 'Rule', description: 'Legal principle or statute', color: '#10b981' },
        { name: 'Application', description: 'Application of rule to facts', color: '#f59e0b' },
        { name: 'Conclusion', description: 'Resolution of the issue', color: '#ef4444' },
      ],
    },
  ]),
}));

import { getTextPositionSelector, getTargetSelector } from '@semiont/api-client';

const mockGetTextPositionSelector = getTextPositionSelector as MockedFunction<typeof getTextPositionSelector>;
const mockGetTargetSelector = getTargetSelector as MockedFunction<typeof getTargetSelector>;

// Test data fixtures
const createMockTag = (id: string, start: number, end: number, tagName: string = 'Issue'): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id,
  type: 'Annotation',
  motivation: 'tagging',
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
      value: tagName,
      purpose: 'tagging',
    },
  ],
});

const mockTags = {
  empty: [],
  single: [createMockTag('1', 0, 10)],
  multiple: [
    createMockTag('1', 50, 60, 'Issue'),
    createMockTag('2', 0, 10, 'Rule'),
    createMockTag('3', 100, 110, 'Conclusion'),
  ],
};

// Helper to create pending annotation
const createPendingAnnotation = (exact: string) => ({
  motivation: 'tagging' as const,
  selector: {
    type: 'TextQuoteSelector' as const,
    exact,
  },
});

describe('TaggingPanel Component', () => {
  const defaultProps = {
    annotations: mockTags.empty,
    onAnnotationClick: vi.fn(),
    onCreate: vi.fn(),
    focusedAnnotationId: null,
    pendingAnnotation: null,
  };

  beforeEach(() => {
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

    // Mock localStorage
    Storage.prototype.getItem = vi.fn(() => 'true');
    Storage.prototype.setItem = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel header with title and count', () => {
      render(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);

      expect(screen.getByText(/Tags/)).toBeInTheDocument();
      expect(screen.getByText(/\(3\)/)).toBeInTheDocument();
    });

    it('should show empty state when no tags', () => {
      render(<TaggingPanel {...defaultProps} />);

      expect(screen.getByText(/No tags yet/)).toBeInTheDocument();
    });

    it('should render all tags', () => {
      render(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);

      expect(screen.getByTestId('tag-1')).toBeInTheDocument();
      expect(screen.getByTestId('tag-2')).toBeInTheDocument();
      expect(screen.getByTestId('tag-3')).toBeInTheDocument();
    });

    it('should have proper panel structure', () => {
      const { container } = render(<TaggingPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });
  });

  describe('Tag Sorting', () => {
    it('should sort tags by position in resource', () => {
      render(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);

      const tags = screen.getAllByTestId(/tag-/);

      // Should be sorted by start position: tag-2 (0), tag-1 (50), tag-3 (100)
      expect(tags[0]).toHaveAttribute('data-testid', 'tag-2');
      expect(tags[1]).toHaveAttribute('data-testid', 'tag-1');
      expect(tags[2]).toHaveAttribute('data-testid', 'tag-3');
    });

    it('should handle tags without valid selectors', () => {
      mockGetTextPositionSelector.mockReturnValue(null);

      expect(() => {
        render(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);
      }).not.toThrow();
    });
  });

  describe('Manual Tag Creation', () => {
    it('should not show tag creation form by default', () => {
      render(<TaggingPanel {...defaultProps} />);

      expect(screen.queryByText(/Create tag for selection/)).not.toBeInTheDocument();
    });

    it('should show tag creation form when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(/Create tag for selection/)).toBeInTheDocument();
    });

    it('should display quoted selected text in tag creation form', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text for tagging');

      render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(/"Selected text for tagging"/)).toBeInTheDocument();
    });

    it('should truncate long selected text at 100 characters', () => {
      const longText = 'A'.repeat(150);
      const pendingAnnotation = createPendingAnnotation(longText);

      render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(new RegExp(`"${'A'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should show schema selector in tag creation form', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const selects = screen.getAllByText(/Select schema/);
      expect(selects.length).toBeGreaterThan(0);
    });

    it('should show category selector in tag creation form', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(/Select category/)).toBeInTheDocument();
    });

    it('should call onCreate when category is selected', async () => {
      const onCreate = vi.fn();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
          onCreate={onCreate}
        />
      );

      // Find the category selector (the one in the pending annotation form)
      const categorySelects = screen.getAllByRole('combobox');
      const categorySelect = categorySelects.find(select =>
        select.querySelector('option[value=""]')?.textContent === 'Choose a category'
      );

      expect(categorySelect).toBeInTheDocument();

      await userEvent.selectOptions(categorySelect!, 'Issue');

      expect(onCreate).toHaveBeenCalledWith('legal-irac', 'Issue');
    });

    it('should have proper styling for tag creation form', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      const { container } = render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      const tagForm = container.querySelector('.semiont-annotation-prompt');
      expect(tagForm).toBeInTheDocument();
      expect(tagForm).toHaveAttribute('data-type', 'tag');
    });
  });

  describe('Tag Interactions', () => {
    it('should call onAnnotationClick when tag is clicked', () => {
      const onAnnotationClick = vi.fn();
      render(
        <TaggingPanel
          {...defaultProps}
          annotations={mockTags.single}
          onAnnotationClick={onAnnotationClick}
        />
      );

      const tag = screen.getByTestId('tag-1');
      fireEvent.click(tag);

      expect(onAnnotationClick).toHaveBeenCalledWith(mockTags.single[0]);
    });
  });

  describe('Tag Hover Behavior', () => {
    it('should call onAnnotationHover when provided', () => {
      const onAnnotationHover = vi.fn();
      render(
        <TaggingPanel
          {...defaultProps}
          annotations={mockTags.single}
          onAnnotationHover={onAnnotationHover}
        />
      );

      const hoverButton = screen.getByText('Hover');
      fireEvent.mouseEnter(hoverButton);

      expect(onAnnotationHover).toHaveBeenCalledWith('1');
    });

    it('should not error when onAnnotationHover is not provided', () => {
      expect(() => {
        render(
          <TaggingPanel
            {...defaultProps}
            annotations={mockTags.single}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Detection Section', () => {
    it('should render detection section when onDetect is provided and annotateMode is true', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={true}
        />
      );

      expect(screen.getByText(/Detect Tags/)).toBeInTheDocument();
    });

    it('should not render detection section when onDetect is not provided', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(screen.queryByText(/Detect Tags/)).not.toBeInTheDocument();
    });

    it('should not render detection section when annotateMode is false', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={false}
        />
      );

      expect(screen.queryByText(/Detect Tags/)).not.toBeInTheDocument();
    });

    it('should show schema selector in detection section', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={true}
        />
      );

      const selects = screen.getAllByText(/Select schema/);
      expect(selects.length).toBeGreaterThan(0);
    });

    it('should show Select All and Deselect All buttons', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Select All')).toBeInTheDocument();
      expect(screen.getByText('Deselect All')).toBeInTheDocument();
    });

    it('should show category checkboxes', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Issue')).toBeInTheDocument();
      expect(screen.getByText('Rule')).toBeInTheDocument();
      expect(screen.getByText('Application')).toBeInTheDocument();
      expect(screen.getByText('Conclusion')).toBeInTheDocument();
    });

    it('should disable detect button when no categories selected', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={true}
        />
      );

      const detectButton = screen.getByRole('button', { name: /✨ Detect/i });
      expect(detectButton).toBeDisabled();
    });

    it('should enable detect button when categories are selected', async () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={true}
        />
      );

      const issueCheckbox = screen.getByLabelText(/Issue/);
      await userEvent.click(issueCheckbox);

      const detectButton = screen.getByRole('button', { name: /✨ Detect/i });
      expect(detectButton).not.toBeDisabled();
    });

    it('should call onDetect with selected schema and categories', async () => {
      const onDetect = vi.fn();
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={onDetect}
          annotateMode={true}
        />
      );

      const issueCheckbox = screen.getByLabelText(/Issue/);
      const ruleCheckbox = screen.getByLabelText(/Rule/);

      await userEvent.click(issueCheckbox);
      await userEvent.click(ruleCheckbox);

      const detectButton = screen.getByRole('button', { name: /✨ Detect/i });
      await userEvent.click(detectButton);

      expect(onDetect).toHaveBeenCalledWith('legal-irac', ['Issue', 'Rule']);
    });
  });

  describe('Cancel Functionality', () => {
    it('should show Cancel button when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      render(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading structure', () => {
      render(<TaggingPanel {...defaultProps} />);

      const heading = screen.getByText(/Tags/);
      expect(heading).toHaveClass('semiont-panel-header__text');
    });

    it('should have proper checkbox labels', () => {
      render(
        <TaggingPanel
          {...defaultProps}
          onDetect={vi.fn()}
          annotateMode={true}
        />
      );

      expect(screen.getByLabelText(/Issue/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Rule/)).toBeInTheDocument();
    });
  });
});
