import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { TaggingPanel } from '../TaggingPanel';
import { EventBusProvider, resetEventBusForTesting, useEventBus } from '../../../../contexts/EventBusContext';
import type { components } from '@semiont/api-client';

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

      const panelEvents = ['annotation:create', 'detection:start'];

      panelEvents.forEach(eventName => {
        const handler = trackEvent(eventName);
        eventBus.on(eventName, handler);
        handlers.push(() => eventBus.off(eventName, handler));
      });

      return () => {
        handlers.forEach(cleanup => cleanup());
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

// Mock TagEntry component to simplify testing
vi.mock('../TagEntry', () => ({
  TagEntry: ({ tag, onTagRef }: any) => (
    <div data-testid={`tag-${tag.id}`}>
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

    // Mock localStorage
    Storage.prototype.getItem = vi.fn(() => 'true');
    Storage.prototype.setItem = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel header with title and count', () => {
      renderWithEventBus(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);

      const headings = screen.getAllByText(/Tags/);
      expect(headings.length).toBeGreaterThan(0);
      expect(screen.getByText(/\(3\)/)).toBeInTheDocument();
    });

    it('should show empty state when no tags', () => {
      renderWithEventBus(<TaggingPanel {...defaultProps} />);

      expect(screen.getByText(/No tags yet/)).toBeInTheDocument();
    });

    it('should render all tags', () => {
      renderWithEventBus(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);

      expect(screen.getByTestId('tag-1')).toBeInTheDocument();
      expect(screen.getByTestId('tag-2')).toBeInTheDocument();
      expect(screen.getByTestId('tag-3')).toBeInTheDocument();
    });

    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<TaggingPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('semiont-panel');
    });
  });

  describe('Tag Sorting', () => {
    it('should sort tags by position in resource', () => {
      renderWithEventBus(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);

      const tags = screen.getAllByTestId(/tag-/);

      // Should be sorted by start position: tag-2 (0), tag-1 (50), tag-3 (100)
      expect(tags[0]).toHaveAttribute('data-testid', 'tag-2');
      expect(tags[1]).toHaveAttribute('data-testid', 'tag-1');
      expect(tags[2]).toHaveAttribute('data-testid', 'tag-3');
    });

    it('should handle tags without valid selectors', () => {
      mockGetTextPositionSelector.mockReturnValue(null);

      expect(() => {
        renderWithEventBus(<TaggingPanel {...defaultProps} annotations={mockTags.multiple} />);
      }).not.toThrow();
    });
  });

  describe('Manual Tag Creation', () => {
    it('should not show tag creation form by default', () => {
      renderWithEventBus(<TaggingPanel {...defaultProps} />);

      expect(screen.queryByText(/Create tag for selection/)).not.toBeInTheDocument();
    });

    it('should show tag creation form when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(/Create tag for selection/)).toBeInTheDocument();
    });

    it('should display quoted selected text in tag creation form', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text for tagging');

      renderWithEventBus(
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

      renderWithEventBus(
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

      renderWithEventBus(
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

      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      expect(screen.getByText(/Select category/)).toBeInTheDocument();
    });

    it('should emit annotation:create event when category is selected', async () => {
      const tracker = createEventTracker();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />,
        tracker
      );

      // Find the category selector (the one in the pending annotation form)
      const categorySelects = screen.getAllByRole('combobox');
      const categorySelect = categorySelects.find(select =>
        select.querySelector('option[value=""]')?.textContent === 'Choose a category'
      );

      expect(categorySelect).toBeInTheDocument();

      await userEvent.selectOptions(categorySelect!, 'Issue');

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'annotation:create' &&
          e.payload?.motivation === 'tagging' &&
          e.payload?.body?.[0]?.value === 'Issue' &&
          e.payload?.body?.[0]?.schema === 'legal-irac'
        )).toBe(true);
      });
    });

    it('should have proper styling for tag creation form', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      const { container } = renderWithEventBus(
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
    it('should render tag entries', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotations={mockTags.single}
        />
      );

      const tag = screen.getByTestId('tag-1');
      expect(tag).toBeInTheDocument();
    });
  });

  describe('Tag Hover Behavior', () => {
    it('should render without errors', () => {
      expect(() => {
        renderWithEventBus(
          <TaggingPanel
            {...defaultProps}
            annotations={mockTags.single}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Detection Section', () => {
    it('should render detection section when annotateMode is true', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(screen.getByText(/Detect Tags/)).toBeInTheDocument();
    });

    it('should not render detection section when annotateMode is false', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={false}
        />
      );

      expect(screen.queryByText(/Detect Tags/)).not.toBeInTheDocument();
    });

    it('should show schema selector in detection section', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      const selects = screen.getAllByText(/Select schema/);
      expect(selects.length).toBeGreaterThan(0);
    });

    it('should show Select All and Deselect All buttons', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Select All')).toBeInTheDocument();
      expect(screen.getByText('Deselect All')).toBeInTheDocument();
    });

    it('should show category checkboxes', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(screen.getByText('Issue')).toBeInTheDocument();
      expect(screen.getByText('Rule')).toBeInTheDocument();
      expect(screen.getByText('Application')).toBeInTheDocument();
      expect(screen.getByText('Conclusion')).toBeInTheDocument();
    });

    it('should disable detect button when no categories selected', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      const detectButton = screen.getByRole('button', { name: /✨ Detect/i });
      expect(detectButton).toBeDisabled();
    });

    it('should enable detect button when categories are selected', async () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      const issueCheckbox = screen.getByLabelText(/Issue/);
      await userEvent.click(issueCheckbox);

      const detectButton = screen.getByRole('button', { name: /✨ Detect/i });
      expect(detectButton).not.toBeDisabled();
    });

    it('should emit detection:start event with selected schema and categories', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />,
        tracker
      );

      const issueCheckbox = screen.getByLabelText(/Issue/);
      const ruleCheckbox = screen.getByLabelText(/Rule/);

      await userEvent.click(issueCheckbox);
      await userEvent.click(ruleCheckbox);

      const detectButton = screen.getByRole('button', { name: /✨ Detect/i });
      await userEvent.click(detectButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'detection:start' &&
          e.payload?.motivation === 'tagging' &&
          e.payload?.options?.schemaId === 'legal-irac' &&
          e.payload?.options?.categories?.includes('Issue') &&
          e.payload?.options?.categories?.includes('Rule')
        )).toBe(true);
      });
    });
  });

  describe('Cancel Functionality', () => {
    it('should show Cancel button when pendingAnnotation exists', () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
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
      renderWithEventBus(<TaggingPanel {...defaultProps} />);

      const headings = screen.getAllByText(/Tags/);
      expect(headings[0]).toHaveClass('semiont-panel-header__text');
    });

    it('should have proper checkbox labels', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(screen.getByLabelText(/Issue/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Rule/)).toBeInTheDocument();
    });
  });
});
