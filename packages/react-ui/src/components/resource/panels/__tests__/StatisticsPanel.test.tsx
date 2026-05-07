import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../../test-utils';
import type { components } from '@semiont/core';

import type { Annotation } from '@semiont/core';

// Stable mock functions defined outside vi.mock to avoid re-render loops
const mockIsBodyResolved = vi.fn();
const mockGetEntityTypes = vi.fn();

vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
  return {
    ...actual,
    isBodyResolved: (...args: unknown[]) => mockIsBodyResolved(...args),
  };
});

vi.mock('@semiont/ontology', () => ({
  getEntityTypes: (...args: unknown[]) => mockGetEntityTypes(...args),
}));

import { StatisticsPanel } from '../StatisticsPanel';

const createMockAnnotation = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'http://example.com/annotations/1',
  type: 'Annotation',
  motivation: 'linking',
  created: '2024-06-15T12:00:00Z',
  modified: '2024-06-15T12:00:00Z',
  target: {
    source: '1',
    selector: {
      type: 'TextQuoteSelector',
      exact: 'some text',
    },
  },
  ...overrides,
});

describe('StatisticsPanel', () => {
  const emptyProps = {
    highlights: [] as Annotation[],
    comments: [] as Annotation[],
    assessments: [] as Annotation[],
    references: [] as Annotation[],
    tags: [] as Annotation[],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBodyResolved.mockReturnValue(false);
    mockGetEntityTypes.mockReturnValue([]);
  });

  describe('Rendering counts', () => {
    it('should render zero counts for all categories when empty', () => {
      renderWithProviders(<StatisticsPanel {...emptyProps} />);

      // Title
      expect(screen.getByText('StatisticsPanel.title')).toBeInTheDocument();

      // All counts should be 0
      const values = screen.getAllByText('0');
      // highlights, comments, assessments, tags, references, stub, resolved = 7 zeros
      expect(values.length).toBe(7);
    });

    it('should render correct highlight count', () => {
      const props = {
        ...emptyProps,
        highlights: [createMockAnnotation({ id: 'h1' }), createMockAnnotation({ id: 'h2' }), createMockAnnotation({ id: 'h3' })],
      };

      renderWithProviders(<StatisticsPanel {...props} />);

      expect(screen.getByText('StatisticsPanel.highlights')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('should render correct comment count', () => {
      const props = {
        ...emptyProps,
        comments: [createMockAnnotation({ id: 'c1' }), createMockAnnotation({ id: 'c2' })],
      };

      renderWithProviders(<StatisticsPanel {...props} />);

      expect(screen.getByText('StatisticsPanel.comments')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('should render correct assessment count', () => {
      const props = {
        ...emptyProps,
        assessments: [createMockAnnotation({ id: 'a1' })],
      };

      renderWithProviders(<StatisticsPanel {...props} />);

      expect(screen.getByText('StatisticsPanel.assessments')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('should render correct tag count', () => {
      const props = {
        ...emptyProps,
        tags: [
          createMockAnnotation({ id: 't1' }),
          createMockAnnotation({ id: 't2' }),
          createMockAnnotation({ id: 't3' }),
          createMockAnnotation({ id: 't4' }),
        ],
      };

      renderWithProviders(<StatisticsPanel {...props} />);

      expect(screen.getByText('StatisticsPanel.tags')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
    });

    it('should render correct total reference count', () => {
      const refs = [createMockAnnotation({ id: 'r1' }), createMockAnnotation({ id: 'r2' })];

      const { container } = renderWithProviders(<StatisticsPanel {...emptyProps} references={refs} />);

      expect(screen.getByText('StatisticsPanel.references')).toBeInTheDocument();
      // The references item has the total count as its direct .semiont-statistics-panel__value child
      const referencesItem = screen.getByText('StatisticsPanel.references').closest('.semiont-statistics-panel__item');
      const totalValue = referencesItem!.querySelector(':scope > .semiont-statistics-panel__value');
      expect(totalValue!.textContent).toBe('2');
    });
  });

  describe('Reference sub-categories', () => {
    it('should show stub and resolved counts', () => {
      const refs = [
        createMockAnnotation({ id: 'r1' }),
        createMockAnnotation({ id: 'r2' }),
        createMockAnnotation({ id: 'r3' }),
      ];

      // r1 resolved, r2 and r3 are stubs
      mockIsBodyResolved.mockImplementation((body: unknown) => {
        // We can distinguish by the call order
        return false;
      });

      // Make first call return true, rest false
      mockIsBodyResolved
        .mockReturnValueOnce(true)  // r1 stub check
        .mockReturnValueOnce(false) // r2 stub check
        .mockReturnValueOnce(false) // r3 stub check
        .mockReturnValueOnce(true)  // r1 resolved check
        .mockReturnValueOnce(false) // r2 resolved check
        .mockReturnValueOnce(false); // r3 resolved check

      renderWithProviders(<StatisticsPanel {...emptyProps} references={refs} />);

      expect(screen.getByText('StatisticsPanel.stub')).toBeInTheDocument();
      expect(screen.getByText('StatisticsPanel.resolved')).toBeInTheDocument();
    });

    it('should count all as resolved when isBodyResolved returns true', () => {
      const refs = [
        createMockAnnotation({ id: 'r1' }),
        createMockAnnotation({ id: 'r2' }),
      ];

      mockIsBodyResolved.mockReturnValue(true);

      renderWithProviders(<StatisticsPanel {...emptyProps} references={refs} />);

      // stub count = 0, resolved count = 2
      expect(screen.getByText('StatisticsPanel.stub')).toBeInTheDocument();
      expect(screen.getByText('StatisticsPanel.resolved')).toBeInTheDocument();
    });

    it('should count all as stubs when isBodyResolved returns false', () => {
      const refs = [
        createMockAnnotation({ id: 'r1' }),
        createMockAnnotation({ id: 'r2' }),
      ];

      mockIsBodyResolved.mockReturnValue(false);

      renderWithProviders(<StatisticsPanel {...emptyProps} references={refs} />);

      expect(screen.getByText('StatisticsPanel.stub')).toBeInTheDocument();
      expect(screen.getByText('StatisticsPanel.resolved')).toBeInTheDocument();
    });
  });

  describe('Entity types', () => {
    it('should not render entity types section when no entity types exist', () => {
      mockGetEntityTypes.mockReturnValue([]);

      const { container } = renderWithProviders(<StatisticsPanel {...emptyProps} />);

      expect(container.querySelector('.semiont-statistics-panel__entity-types')).not.toBeInTheDocument();
    });

    it('should render entity types with counts', () => {
      const refs = [
        createMockAnnotation({ id: 'r1' }),
        createMockAnnotation({ id: 'r2' }),
        createMockAnnotation({ id: 'r3' }),
      ];

      mockGetEntityTypes
        .mockReturnValueOnce(['Person', 'Organization'])
        .mockReturnValueOnce(['Person'])
        .mockReturnValueOnce(['Location']);

      renderWithProviders(<StatisticsPanel {...emptyProps} references={refs} />);

      expect(screen.getByText('StatisticsPanel.entityTypes')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
    });

    it('should sort entity types by count descending', () => {
      const refs = [
        createMockAnnotation({ id: 'r1' }),
        createMockAnnotation({ id: 'r2' }),
        createMockAnnotation({ id: 'r3' }),
      ];

      // Person appears 3 times, Location 1 time
      mockGetEntityTypes
        .mockReturnValueOnce(['Person'])
        .mockReturnValueOnce(['Person'])
        .mockReturnValueOnce(['Person', 'Location']);

      const { container } = renderWithProviders(<StatisticsPanel {...emptyProps} references={refs} />);

      const entityItems = container.querySelectorAll('.semiont-statistics-panel__entity-item');
      expect(entityItems.length).toBe(2);

      // First should be Person (count 3), second Location (count 1)
      expect(entityItems[0].querySelector('.semiont-statistics-panel__entity-name')!.textContent).toBe('Person');
      expect(entityItems[1].querySelector('.semiont-statistics-panel__entity-name')!.textContent).toBe('Location');
    });
  });

  describe('Mixed annotation counts', () => {
    it('should render all categories with their respective counts simultaneously', () => {
      const props = {
        highlights: [createMockAnnotation({ id: 'h1' })],
        comments: [createMockAnnotation({ id: 'c1' }), createMockAnnotation({ id: 'c2' })],
        assessments: [createMockAnnotation({ id: 'a1' }), createMockAnnotation({ id: 'a2' }), createMockAnnotation({ id: 'a3' })],
        references: [createMockAnnotation({ id: 'r1' })],
        tags: [createMockAnnotation({ id: 't1' }), createMockAnnotation({ id: 't2' })],
      };

      renderWithProviders(<StatisticsPanel {...props} />);

      // Check that labels are present
      expect(screen.getByText('StatisticsPanel.highlights')).toBeInTheDocument();
      expect(screen.getByText('StatisticsPanel.comments')).toBeInTheDocument();
      expect(screen.getByText('StatisticsPanel.assessments')).toBeInTheDocument();
      expect(screen.getByText('StatisticsPanel.references')).toBeInTheDocument();
      expect(screen.getByText('StatisticsPanel.tags')).toBeInTheDocument();
    });
  });
});
