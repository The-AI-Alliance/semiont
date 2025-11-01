import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ResourceInfoPanel } from '../ResourceInfoPanel';
import type { components, paths } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type ReferencedBy = ResponseContent<paths['/api/resources/{id}/referenced-by']['get']>['referencedBy'][number];

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      locale: 'Locale',
      notSpecified: 'Not specified',
      entityTypeTags: 'Entity Type Tags',
      statistics: 'Statistics',
      highlights: 'Highlights',
      comments: 'Comments',
      assessments: 'Assessments',
      references: 'References',
      stub: 'Stub',
      resolved: 'Resolved',
      entityTypes: 'Entity Types',
      referencedBy: 'Referenced By',
      loading: 'loading',
      loadingEllipsis: 'Loading...',
      untitledResource: 'Untitled Resource',
      noText: 'No text',
      noIncomingReferences: 'No incoming references',
    };
    return translations[key] || key;
  }),
}));

// Mock @/i18n/routing
vi.mock('@/i18n/routing', () => ({
  Link: ({ children, href, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock @semiont/api-client utilities
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    formatLocaleDisplay: vi.fn(),
    isBodyResolved: vi.fn(),
    getEntityTypes: vi.fn(),
  };
});

import { formatLocaleDisplay, isBodyResolved, getEntityTypes } from '@semiont/api-client';
import type { MockedFunction } from 'vitest';

const mockFormatLocaleDisplay = formatLocaleDisplay as MockedFunction<typeof formatLocaleDisplay>;
const mockIsBodyResolved = isBodyResolved as MockedFunction<typeof isBodyResolved>;
const mockGetEntityTypes = getEntityTypes as MockedFunction<typeof getEntityTypes>;

// Test data fixtures
const createMockAnnotation = (id: string, motivation: string): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id,
  type: 'Annotation',
  motivation,
  creator: { name: 'user@example.com' },
  created: '2024-01-01T10:00:00Z',
  modified: '2024-01-01T10:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextPositionSelector',
      start: 0,
      end: 10,
    },
  },
  body: [
    {
      type: 'TextualBody',
      value: `Content for ${id}`,
      purpose: motivation,
    },
  ],
});

const createMockReferencedBy = (id: string, resourceName?: string): ReferencedBy => ({
  id,
  target: {
    source: `resource-${id}`,
    selector: {
      type: 'TextPositionSelector',
      start: 0,
      end: 20,
      exact: `Referenced text from ${id}`,
    },
  },
  resourceName: resourceName || `Resource ${id}`,
});

describe('ResourceInfoPanel Component', () => {
  const defaultProps = {
    highlights: [],
    comments: [],
    assessments: [],
    references: [],
    referencedBy: [],
    referencedByLoading: false,
    documentEntityTypes: [],
    documentLocale: undefined,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFormatLocaleDisplay.mockReturnValue('English (United States)');
    mockIsBodyResolved.mockReturnValue(false);
    mockGetEntityTypes.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render all sections', () => {
      render(<ResourceInfoPanel {...defaultProps} />);

      expect(screen.getByText('Locale')).toBeInTheDocument();
      expect(screen.getByText('Statistics')).toBeInTheDocument();
    });

    it('should render locale when provided', () => {
      render(<ResourceInfoPanel {...defaultProps} documentLocale="en-US" />);

      expect(mockFormatLocaleDisplay).toHaveBeenCalledWith('en-US');
      expect(screen.getByText('English (United States)')).toBeInTheDocument();
    });

    it('should show "not specified" when locale is undefined', () => {
      render(<ResourceInfoPanel {...defaultProps} documentLocale={undefined} />);

      expect(screen.getByText('Not specified')).toBeInTheDocument();
    });

    it('should render entity type tags when provided', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['Person', 'Organization', 'Location']}
        />
      );

      expect(screen.getByText('Entity Type Tags')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
    });

    it('should not render entity type tags section when empty', () => {
      render(<ResourceInfoPanel {...defaultProps} documentEntityTypes={[]} />);

      expect(screen.queryByText('Entity Type Tags')).not.toBeInTheDocument();
    });
  });

  describe('Statistics Display', () => {
    it('should display zero counts for empty annotations', () => {
      render(<ResourceInfoPanel {...defaultProps} />);

      // Check specific sections have zero counts
      const highlightSection = screen.getByText('Highlights').parentElement;
      expect(highlightSection).toHaveTextContent('0');

      const commentSection = screen.getByText('Comments').parentElement;
      expect(commentSection).toHaveTextContent('0');
    });

    it('should display highlight count', () => {
      const highlights = [
        createMockAnnotation('h1', 'highlighting'),
        createMockAnnotation('h2', 'highlighting'),
        createMockAnnotation('h3', 'highlighting'),
      ];

      render(<ResourceInfoPanel {...defaultProps} highlights={highlights} />);

      const highlightSection = screen.getByText('Highlights').parentElement;
      expect(highlightSection).toHaveTextContent('3');
    });

    it('should display comment count', () => {
      const comments = [
        createMockAnnotation('c1', 'commenting'),
        createMockAnnotation('c2', 'commenting'),
      ];

      render(<ResourceInfoPanel {...defaultProps} comments={comments} />);

      const commentSection = screen.getByText('Comments').parentElement;
      expect(commentSection).toHaveTextContent('2');
    });

    it('should display assessment count', () => {
      const assessments = [createMockAnnotation('a1', 'assessing')];

      render(<ResourceInfoPanel {...defaultProps} assessments={assessments} />);

      const assessmentSection = screen.getByText('Assessments').parentElement;
      expect(assessmentSection).toHaveTextContent('1');
    });

    it('should display reference count', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
        createMockAnnotation('r3', 'linking'),
        createMockAnnotation('r4', 'linking'),
      ];

      render(<ResourceInfoPanel {...defaultProps} references={references} />);

      const referenceSection = screen.getByText('References').parentElement;
      expect(referenceSection).toHaveTextContent('4');
    });
  });

  describe('Reference Categorization', () => {
    it('should categorize references as stub and resolved', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
        createMockAnnotation('r3', 'linking'),
        createMockAnnotation('r4', 'linking'),
      ];

      // Mock 2 as stub, 2 as resolved
      mockIsBodyResolved.mockImplementation((body: any) => {
        return body[0]?.value.includes('r3') || body[0]?.value.includes('r4');
      });

      render(<ResourceInfoPanel {...defaultProps} references={references} />);

      expect(screen.getByText('Stub')).toBeInTheDocument();
      expect(screen.getByText('Resolved')).toBeInTheDocument();

      const stubSection = screen.getByText('Stub').closest('div');
      const resolvedSection = screen.getByText('Resolved').closest('div');

      expect(stubSection).toHaveTextContent('2');
      expect(resolvedSection).toHaveTextContent('2');
    });

    it('should show all references as stub when none are resolved', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
      ];

      mockIsBodyResolved.mockReturnValue(false);

      render(<ResourceInfoPanel {...defaultProps} references={references} />);

      const stubSection = screen.getByText('Stub').closest('div');
      const resolvedSection = screen.getByText('Resolved').closest('div');

      expect(stubSection).toHaveTextContent('2');
      expect(resolvedSection).toHaveTextContent('0');
    });

    it('should show all references as resolved when all are resolved', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
        createMockAnnotation('r3', 'linking'),
      ];

      mockIsBodyResolved.mockReturnValue(true);

      render(<ResourceInfoPanel {...defaultProps} references={references} />);

      const stubSection = screen.getByText('Stub').closest('div');
      const resolvedSection = screen.getByText('Resolved').closest('div');

      expect(stubSection).toHaveTextContent('0');
      expect(resolvedSection).toHaveTextContent('3');
    });
  });

  describe('Entity Types Aggregation', () => {
    it('should not show entity types section when no references have types', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
      ];

      mockGetEntityTypes.mockReturnValue([]);

      render(<ResourceInfoPanel {...defaultProps} references={references} />);

      // Entity Types heading should not appear in statistics section
      const statisticsSection = screen.getByText('Statistics').closest('div');
      expect(statisticsSection?.textContent).not.toMatch(/Entity Types.*\d+/);
    });

    it('should aggregate and display entity types from references', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
        createMockAnnotation('r3', 'linking'),
      ];

      mockGetEntityTypes.mockImplementation((annotation: any) => {
        if (annotation.id === 'r1') return ['Person', 'Organization'];
        if (annotation.id === 'r2') return ['Person'];
        if (annotation.id === 'r3') return ['Location'];
        return [];
      });

      render(<ResourceInfoPanel {...defaultProps} references={references} />);

      // Should show Entity Types section
      expect(screen.getByText('Entity Types')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
    });

    it('should show count for each entity type', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
        createMockAnnotation('r3', 'linking'),
        createMockAnnotation('r4', 'linking'),
      ];

      mockGetEntityTypes.mockImplementation((annotation: any) => {
        if (annotation.id === 'r1') return ['Person'];
        if (annotation.id === 'r2') return ['Person'];
        if (annotation.id === 'r3') return ['Person'];
        if (annotation.id === 'r4') return ['Organization'];
        return [];
      });

      render(<ResourceInfoPanel {...defaultProps} references={references} />);

      // Person should appear 3 times
      const personRow = screen.getByText('Person').closest('div');
      expect(personRow).toHaveTextContent('3');

      // Organization should appear 1 time
      const orgRow = screen.getByText('Organization').closest('div');
      expect(orgRow).toHaveTextContent('1');
    });

    it('should sort entity types by count descending', () => {
      const references = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
        createMockAnnotation('r3', 'linking'),
      ];

      mockGetEntityTypes.mockImplementation((annotation: any) => {
        if (annotation.id === 'r1') return ['TypeA', 'TypeB'];
        if (annotation.id === 'r2') return ['TypeB', 'TypeC'];
        if (annotation.id === 'r3') return ['TypeB'];
        return [];
      });

      const { container } = render(<ResourceInfoPanel {...defaultProps} references={references} />);

      // TypeB should appear first (count: 3), then TypeA (count: 1), then TypeC (count: 1)
      const entityTypesSection = screen.getByText('Entity Types').closest('div');
      const typeElements = entityTypesSection?.querySelectorAll('.text-gray-700.dark\\:text-gray-300');

      if (typeElements && typeElements.length >= 3) {
        expect(typeElements[0].textContent).toBe('TypeB');
        // TypeA and TypeC both have count 1, order between them is stable but not guaranteed
      }
    });
  });

  describe('Referenced By Section', () => {
    it('should show "no incoming references" when list is empty and not loading', () => {
      render(<ResourceInfoPanel {...defaultProps} referencedBy={[]} referencedByLoading={false} />);

      expect(screen.getByText('No incoming references')).toBeInTheDocument();
    });

    it('should show "Loading..." when loading', () => {
      render(<ResourceInfoPanel {...defaultProps} referencedBy={[]} referencedByLoading={true} />);

      expect(screen.getByText('(loading)')).toBeInTheDocument();
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('should display referenced by items', () => {
      const referencedBy = [
        createMockReferencedBy('1', 'Document A'),
        createMockReferencedBy('2', 'Document B'),
      ];

      render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);

      expect(screen.getByText('Document A')).toBeInTheDocument();
      expect(screen.getByText('Document B')).toBeInTheDocument();
    });

    it('should display referenced text excerpt', () => {
      const referencedBy = [createMockReferencedBy('1')];

      render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);

      expect(screen.getByText('"Referenced text from 1"')).toBeInTheDocument();
    });

    it('should create links to referencing resources', () => {
      const referencedBy = [createMockReferencedBy('1', 'Document A')];

      render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);

      const link = screen.getByText('Document A');
      expect(link.closest('a')).toHaveAttribute('href', '/know/resource/resource-1');
    });

    it('should show "Untitled Resource" when resource name is missing', () => {
      const referencedBy: ReferencedBy[] = [
        {
          id: '1',
          target: {
            source: 'resource-1',
            selector: {
              type: 'TextPositionSelector',
              start: 0,
              end: 10,
              exact: 'Some text',
            },
          },
          resourceName: undefined,
        },
      ];

      render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);

      expect(screen.getByText('Untitled Resource')).toBeInTheDocument();
    });

    it('should show "No text" when exact text is missing', () => {
      const referencedBy: ReferencedBy[] = [
        {
          id: '1',
          target: {
            source: 'resource-1',
            selector: {
              type: 'TextPositionSelector',
              start: 0,
              end: 10,
            },
          },
          resourceName: 'Document A',
        },
      ];

      render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);

      expect(screen.getByText('"No text"')).toBeInTheDocument();
    });

    it('should encode resource ID in URL', () => {
      const referencedBy: ReferencedBy[] = [
        {
          id: '1',
          target: {
            source: 'resource/with/slashes',
            selector: {
              type: 'TextPositionSelector',
              start: 0,
              end: 10,
              exact: 'Text',
            },
          },
          resourceName: 'Document A',
        },
      ];

      render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);

      const link = screen.getByText('Document A').closest('a');
      expect(link?.getAttribute('href')).toContain('resource%2Fwith%2Fslashes');
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = render(<ResourceInfoPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('bg-white', 'dark:bg-gray-800', 'rounded-lg', 'shadow-sm', 'p-4', 'space-y-4');
    });

    it('should style entity type tags appropriately', () => {
      render(<ResourceInfoPanel {...defaultProps} documentEntityTypes={['Person']} />);

      const tag = screen.getByText('Person');
      expect(tag).toHaveClass(
        'inline-flex',
        'bg-blue-100',
        'dark:bg-blue-900/30',
        'text-blue-700',
        'dark:text-blue-300'
      );
    });

    it('should support dark mode', () => {
      const { container } = render(<ResourceInfoPanel {...defaultProps} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('dark:bg-gray-800');
    });
  });

  describe('Edge Cases', () => {
    it('should handle large number of annotations', () => {
      const highlights = Array.from({ length: 100 }, (_, i) =>
        createMockAnnotation(`h${i}`, 'highlighting')
      );
      const comments = Array.from({ length: 50 }, (_, i) =>
        createMockAnnotation(`c${i}`, 'commenting')
      );
      const references = Array.from({ length: 200 }, (_, i) =>
        createMockAnnotation(`r${i}`, 'linking')
      );

      expect(() => {
        render(
          <ResourceInfoPanel
            {...defaultProps}
            highlights={highlights}
            comments={comments}
            references={references}
          />
        );
      }).not.toThrow();

      const highlightSection = screen.getByText('Highlights').parentElement;
      expect(highlightSection).toHaveTextContent('100');

      const commentSection = screen.getByText('Comments').parentElement;
      expect(commentSection).toHaveTextContent('50');

      const referenceSection = screen.getByText('References').parentElement;
      expect(referenceSection).toHaveTextContent('200');
    });

    it('should handle many entity types', () => {
      const references = Array.from({ length: 50 }, (_, i) =>
        createMockAnnotation(`r${i}`, 'linking')
      );

      mockGetEntityTypes.mockImplementation((annotation: any) => {
        const id = parseInt(annotation.id.replace('r', ''));
        return [`Type${id % 10}`]; // Creates 10 different types
      });

      expect(() => {
        render(<ResourceInfoPanel {...defaultProps} references={references} />);
      }).not.toThrow();
    });

    it('should handle many referenced by items', () => {
      const referencedBy = Array.from({ length: 20 }, (_, i) =>
        createMockReferencedBy(`${i}`, `Document ${i}`)
      );

      expect(() => {
        render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);
      }).not.toThrow();

      expect(screen.getByText('Document 0')).toBeInTheDocument();
      expect(screen.getByText('Document 19')).toBeInTheDocument();
    });

    it('should handle empty entity type arrays from getEntityTypes', () => {
      const references = [createMockAnnotation('r1', 'linking')];
      mockGetEntityTypes.mockReturnValue([]);

      expect(() => {
        render(<ResourceInfoPanel {...defaultProps} references={references} />);
      }).not.toThrow();
    });

    it('should handle undefined values gracefully', () => {
      expect(() => {
        render(
          <ResourceInfoPanel
            {...defaultProps}
            documentLocale={undefined}
            documentEntityTypes={[]}
          />
        );
      }).not.toThrow();
    });
  });

  describe('Memoization', () => {
    it('should recalculate stub/resolved counts when references change', () => {
      const { rerender } = render(
        <ResourceInfoPanel
          {...defaultProps}
          references={[createMockAnnotation('r1', 'linking')]}
        />
      );

      mockIsBodyResolved.mockReturnValue(false);

      const stubSection1 = screen.getByText('Stub').closest('div');
      expect(stubSection1).toHaveTextContent('1');

      // Change references
      const newReferences = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
      ];

      rerender(<ResourceInfoPanel {...defaultProps} references={newReferences} />);

      const stubSection2 = screen.getByText('Stub').closest('div');
      expect(stubSection2).toHaveTextContent('2');
    });

    it('should recalculate entity types when references change', () => {
      mockGetEntityTypes.mockReturnValue(['Person']);

      const { rerender } = render(
        <ResourceInfoPanel
          {...defaultProps}
          references={[createMockAnnotation('r1', 'linking')]}
        />
      );

      expect(screen.getByText('Person')).toBeInTheDocument();

      // Add another reference with a different type
      mockGetEntityTypes.mockImplementation((annotation: any) => {
        if (annotation.id === 'r1') return ['Person'];
        if (annotation.id === 'r2') return ['Organization'];
        return [];
      });

      const newReferences = [
        createMockAnnotation('r1', 'linking'),
        createMockAnnotation('r2', 'linking'),
      ];

      rerender(<ResourceInfoPanel {...defaultProps} references={newReferences} />);

      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have semantic heading structure', () => {
      render(<ResourceInfoPanel {...defaultProps} />);

      expect(screen.getByText('Locale')).toHaveClass('text-sm', 'font-semibold');
      expect(screen.getByText('Statistics')).toHaveClass('text-sm', 'font-semibold');
    });

    it('should have proper link attributes for referenced by items', () => {
      const referencedBy = [createMockReferencedBy('1', 'Document A')];

      render(<ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />);

      const link = screen.getByText('Document A').closest('a');
      expect(link).toHaveAttribute('href');
      expect(link).toHaveClass('hover:underline');
    });

    it('should use semantic HTML for lists', () => {
      const referencedBy = [
        createMockReferencedBy('1'),
        createMockReferencedBy('2'),
      ];

      const { container } = render(
        <ResourceInfoPanel {...defaultProps} referencedBy={referencedBy} />
      );

      // Should have a space-y div container for list items
      const referencedBySection = screen.getByText('Referenced By').closest('div');
      expect(referencedBySection?.querySelector('.space-y-2')).toBeInTheDocument();
    });
  });
});
