import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { of } from 'rxjs';
import { CacheObservable } from '@semiont/sdk';
import { TaggingPanel } from '../TaggingPanel';
import type { components, EventBus, TagSchema } from '@semiont/core';
import { createTestSemiontWrapper } from '../../../../test-utils';

import type { Annotation } from '@semiont/core';

// Composition-based event tracker
interface TrackedEvent {
  event: string;
  payload: any;
}

function createEventTracker() {
  const events: TrackedEvent[] = [];
  return {
    events,
    clear: () => { events.length = 0; },
    _attach(eventBus: EventBus) {
      const panelEvents = ['mark:submit', 'mark:assist-request'] as const;
      panelEvents.forEach((eventName) => {
        eventBus.get(eventName).subscribe((payload: any) => {
          events.push({ event: eventName, payload });
        });
      });
    },
  };
}

// Test tag schemas — the panel subscribes to `client.browse.tagSchemas()`.
// We stub that method directly to return a `CacheObservable` that emits
// these schemas synchronously, mirroring the post-resolve cache state
// without the round-trip through bus/transport plumbing.
const TEST_TAG_SCHEMAS: TagSchema[] = [
  {
    id: 'legal-irac',
    name: 'Legal (IRAC)',
    description: 'Issue, Rule, Application, Conclusion framework for legal analysis',
    domain: 'legal',
    tags: [
      { name: 'Issue',       description: 'Legal question to be resolved', examples: [] },
      { name: 'Rule',        description: 'Legal principle or statute',    examples: [] },
      { name: 'Application', description: 'Application of rule to facts',  examples: [] },
      { name: 'Conclusion',  description: 'Resolution of the issue',       examples: [] },
    ],
  },
];

const renderWithEventBus = (component: React.ReactElement, tracker?: ReturnType<typeof createEventTracker>) => {
  const { SemiontWrapper, eventBus, client } = createTestSemiontWrapper();
  vi.spyOn(client.browse, 'tagSchemas').mockReturnValue(
    CacheObservable.from(of(TEST_TAG_SCHEMAS))
  );
  if (tracker) tracker._attach(eventBus);
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  return render(component, { wrapper: Wrapper });
};

// Variant for the empty-registry case: the cache resolves to `[]`
// (post-bootstrap, no schemas registered). Distinct from the still-
// loading case where the observable yields `undefined`.
const renderWithEmptyRegistry = (component: React.ReactElement) => {
  const { SemiontWrapper, client } = createTestSemiontWrapper();
  vi.spyOn(client.browse, 'tagSchemas').mockReturnValue(
    CacheObservable.from(of([]))
  );
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  return render(component, { wrapper: Wrapper });
};

// Mock TranslationContext. The component now uses `schema.name` /
// `category.name` directly off the registered TagSchema objects (Stage 2.B
// of TAG-SCHEMAS-GAP), so the per-schema/per-category translation keys
// the older mock carried (`schemaLegal`, `categoryIssue`, etc.) are no
// longer referenced — kept the mock minimal.
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string, params?: Record<string, any>) => {
    const translations: Record<string, string> = {
      title: 'Tags',
      noTags: 'No tags yet. Select text to add a tag.',
      noSchemas: 'No tag schemas registered for this knowledge base.',
      createTagForSelection: 'Create tag for selection',
      selectSchema: 'Select schema',
      selectCategory: 'Select category',
      selectCategories: 'Select categories',
      chooseCategory: 'Choose a category',
      annotateTags: 'Annotate Tags',
      annotate: 'Annotate',
      cancel: 'Cancel',
      fragmentSelected: 'Fragment selected',
      selectAll: 'Select All',
      deselectAll: 'Deselect All',
      categoriesSelected: '{count} categories selected',
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
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
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

import { getTextPositionSelector, getTargetSelector } from '@semiont/core';
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

    it('should show category selector in tag creation form', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />
      );

      // The category selector only renders once the schema list has
      // resolved and the default schema (first registered) has been
      // picked — async because the schemas come from `browse.tagSchemas()`.
      expect(await screen.findByText(/Select category/)).toBeInTheDocument();
    });

    it('should emit mark:submitevent when category is selected', async () => {
      const tracker = createEventTracker();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />,
        tracker
      );

      // Wait for the schema list to load — `browse.tagSchemas()` is
      // async, so the category dropdown only renders after the bus
      // response lands.
      await screen.findByText(/Select category/);
      const categorySelects = screen.getAllByRole('combobox');
      const categorySelect = categorySelects.find(select =>
        select.querySelector('option[value=""]')?.textContent === 'Choose a category'
      );

      expect(categorySelect).toBeInTheDocument();

      await userEvent.selectOptions(categorySelect!, 'Issue');

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:submit' &&
          e.payload?.motivation === 'tagging' &&
          e.payload?.body?.[0]?.value === 'Issue' &&
          e.payload?.body?.[0]?.type === 'TextualBody'
        )).toBe(true);
      });
    });

    it('should include schema id as classifying body alongside tagging body', async () => {
      // Regression: manual tags were missing the classifying body, so getTagSchemaId()
      // returned undefined and TagEntry never showed the schema name.
      const tracker = createEventTracker();
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
        />,
        tracker
      );

      await screen.findByText(/Select category/);
      const categorySelects = screen.getAllByRole('combobox');
      const categorySelect = categorySelects.find(select =>
        select.querySelector('option[value=""]')?.textContent === 'Choose a category'
      );
      await userEvent.selectOptions(categorySelect!, 'Rule');

      await waitFor(() => {
        const createEvent = tracker.events.find(e => e.event === 'mark:submit');
        expect(createEvent).toBeDefined();
        const body: any[] = createEvent!.payload.body;

        // Must have exactly two body elements
        expect(body).toHaveLength(2);

        // First: the category
        expect(body[0]).toMatchObject({
          type: 'TextualBody',
          value: 'Rule',
          purpose: 'tagging',
        });

        // Second: the schema id — this is what was missing before the fix
        expect(body[1]).toMatchObject({
          type: 'TextualBody',
          value: 'legal-irac',
          purpose: 'classifying',
        });
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

      expect(screen.getByText(/Annotate Tags/)).toBeInTheDocument();
    });

    it('should not render detection section when annotateMode is false', () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={false}
        />
      );

      expect(screen.queryByText(/Annotate Tags/)).not.toBeInTheDocument();
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

    it('should show Select All and Deselect All buttons', async () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(await screen.findByText('Select All')).toBeInTheDocument();
      expect(screen.getByText('Deselect All')).toBeInTheDocument();
    });

    it('should show category checkboxes', async () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      // Categories appear once `browse.tagSchemas()` resolves and the
      // default schema is selected.
      expect(await screen.findByText('Issue')).toBeInTheDocument();
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

      const annotateButton = screen.getByRole('button', { name: /✨\s*Annotate/i });
      expect(annotateButton).toBeDisabled();
    });

    it('should enable detect button when categories are selected', async () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      const issueCheckbox = await screen.findByLabelText(/Issue/);
      await userEvent.click(issueCheckbox);

      const annotateButton = screen.getByRole('button', { name: /✨\s*Annotate/i });
      expect(annotateButton).not.toBeDisabled();
    });

    it('should emit annotate:detect-request event with selected schema and categories', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />,
        tracker
      );

      const issueCheckbox = await screen.findByLabelText(/Issue/);
      const ruleCheckbox = screen.getByLabelText(/Rule/);

      await userEvent.click(issueCheckbox);
      await userEvent.click(ruleCheckbox);

      const annotateButton = screen.getByRole('button', { name: /✨\s*Annotate/i });
      await userEvent.click(annotateButton);

      await waitFor(() => {
        expect(tracker.events.some(e =>
          e.event === 'mark:assist-request' &&
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

    it('should have proper checkbox labels', async () => {
      renderWithEventBus(
        <TaggingPanel
          {...defaultProps}
          annotateMode={true}
        />
      );

      expect(await screen.findByLabelText(/Issue/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Rule/)).toBeInTheDocument();
    });
  });

  describe('Empty registry (no tag schemas registered)', () => {
    // The empty path: `browse.tagSchemas()` resolves to `[]` (KB has
    // not run `register-tag-schemas` yet, no skill has registered a
    // schema either). The panel should surface a clear message in
    // both contexts where the schema picker would otherwise render —
    // not just leave the dropdown empty.

    it('shows the noSchemas message in the assist section instead of the picker', async () => {
      renderWithEmptyRegistry(
        <TaggingPanel {...defaultProps} annotateMode={true} />
      );

      // The empty-state message renders…
      expect(
        await screen.findByText(/No tag schemas registered for this knowledge base/i),
      ).toBeInTheDocument();

      // …and the picker UI does NOT (the form-field label `Select schema`
      // is gated on `!noSchemasRegistered`).
      expect(screen.queryByLabelText(/Select schema/i)).not.toBeInTheDocument();
    });

    it('shows the noSchemas message in the pending tag-creation form instead of the picker', async () => {
      const pendingAnnotation = createPendingAnnotation('Selected text');

      renderWithEmptyRegistry(
        <TaggingPanel
          {...defaultProps}
          pendingAnnotation={pendingAnnotation}
          annotateMode={false}
        />
      );

      // The pending form opens. With annotateMode={false} the assist
      // section is skipped so we get exactly one empty-state message —
      // the one inside the pending form. (Default annotateMode=true
      // renders the message in both places, which is the right product
      // behavior; a separate test covers the assist-section path.)
      expect(screen.getByText(/Create tag for selection/)).toBeInTheDocument();
      expect(
        await screen.findByText(/No tag schemas registered for this knowledge base/i),
      ).toBeInTheDocument();
      // No "Select category" label — the second dropdown renders only
      // when `selectedSchema` exists, which requires a schema to be
      // registered first.
      expect(screen.queryByText(/Select category/i)).not.toBeInTheDocument();
    });

    it('keeps the panel rendering tags in the list section even with an empty registry', () => {
      // The existing tag annotations on the resource still render —
      // schema-registration is a write-side concern; reading existing
      // tags doesn't depend on the registry being populated.
      renderWithEmptyRegistry(
        <TaggingPanel {...defaultProps} annotations={mockTags.multiple} />
      );

      expect(screen.getByTestId('tag-1')).toBeInTheDocument();
      expect(screen.getByTestId('tag-2')).toBeInTheDocument();
      expect(screen.getByTestId('tag-3')).toBeInTheDocument();
    });
  });
});
