import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders, resetEventBusForTesting } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

// Mock @semiont/api-client
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getAnnotationExactText: vi.fn(),
  };
});

// Mock @semiont/ontology
vi.mock('@semiont/ontology', () => ({
  getTagCategory: vi.fn(),
  getTagSchemaId: vi.fn(),
}));

// Mock tag-schemas
vi.mock('../../../../lib/tag-schemas', () => ({
  getTagSchema: vi.fn(),
}));

import { getAnnotationExactText } from '@semiont/api-client';
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';
import { getTagSchema } from '../../../../lib/tag-schemas';
import type { MockedFunction } from 'vitest';
import { TagEntry } from '../TagEntry';

const mockGetAnnotationExactText = getAnnotationExactText as MockedFunction<typeof getAnnotationExactText>;
const mockGetTagCategory = getTagCategory as MockedFunction<typeof getTagCategory>;
const mockGetTagSchemaId = getTagSchemaId as MockedFunction<typeof getTagSchemaId>;
const mockGetTagSchema = getTagSchema as MockedFunction<typeof getTagSchema>;

const createMockTag = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'tag-1',
  type: 'Annotation',
  motivation: 'tagging',
  creator: {
    name: 'tagger@example.com',
  },
  created: '2024-06-15T12:00:00Z',
  modified: '2024-06-15T12:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextPositionSelector',
      start: 10,
      end: 30,
    },
  },
  body: {
    type: 'TextualBody',
    value: 'Person',
    purpose: 'tagging',
  },
  ...overrides,
});

describe('TagEntry', () => {
  const defaultProps = {
    tag: createMockTag(),
    isFocused: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBusForTesting();
    mockGetAnnotationExactText.mockReturnValue('Tagged text content');
    mockGetTagCategory.mockReturnValue('Entity');
    mockGetTagSchemaId.mockReturnValue(null);
    mockGetTagSchema.mockReturnValue(null);
  });

  describe('Rendering', () => {
    it('should render the category badge', () => {
      renderWithProviders(<TagEntry {...defaultProps} />);

      expect(screen.getByText('Entity')).toBeInTheDocument();
    });

    it('should render the selected text in quotes', () => {
      renderWithProviders(<TagEntry {...defaultProps} />);

      expect(screen.getByText(/Tagged text content/)).toBeInTheDocument();
    });

    it('should truncate text over 150 characters', () => {
      const longText = 'C'.repeat(200);
      mockGetAnnotationExactText.mockReturnValue(longText);

      renderWithProviders(<TagEntry {...defaultProps} />);

      expect(screen.getByText(new RegExp(`"${'C'.repeat(150)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should not truncate text at exactly 150 characters', () => {
      const exactText = 'D'.repeat(150);
      mockGetAnnotationExactText.mockReturnValue(exactText);

      const { container } = renderWithProviders(<TagEntry {...defaultProps} />);

      const quote = container.querySelector('.semiont-annotation-entry__quote');
      expect(quote).toBeInTheDocument();
      expect(quote!.textContent).not.toContain('...');
    });

    it('should render schema name when available', () => {
      mockGetTagSchemaId.mockReturnValue('schema-ner-v1');
      mockGetTagSchema.mockReturnValue({
        id: 'schema-ner-v1',
        name: 'Named Entity Recognition',
        domain: 'nlp',
        version: '1.0',
        categories: [],
      });

      renderWithProviders(<TagEntry {...defaultProps} />);

      expect(screen.getByText('Named Entity Recognition')).toBeInTheDocument();
    });

    it('should not render schema name when schema is not found', () => {
      mockGetTagSchemaId.mockReturnValue('unknown-schema');
      mockGetTagSchema.mockReturnValue(null);

      const { container } = renderWithProviders(<TagEntry {...defaultProps} />);

      expect(container.querySelector('.semiont-annotation-entry__meta')).not.toBeInTheDocument();
    });

    it('should render category badge with correct data-variant', () => {
      const { container } = renderWithProviders(<TagEntry {...defaultProps} />);

      const badge = container.querySelector('.semiont-tag-badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute('data-variant', 'tag');
    });
  });

  describe('Interactions', () => {
    it('should emit browse:click on click', async () => {
      const clickHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <TagEntry {...defaultProps} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('browse:click').subscribe(clickHandler);

      const entry = container.firstChild as HTMLElement;
      await userEvent.click(entry);

      expect(clickHandler).toHaveBeenCalledWith({
        annotationId: 'tag-1',
        motivation: 'tagging',
      });

      subscription.unsubscribe();
    });
  });

  describe('Hover state', () => {
    it('should apply pulse class when isHovered is true', () => {
      const { container } = renderWithProviders(
        <TagEntry {...defaultProps} isHovered={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveClass('semiont-annotation-pulse');
    });

    it('should not apply pulse class when isHovered is false', () => {
      const { container } = renderWithProviders(
        <TagEntry {...defaultProps} isHovered={false} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).not.toHaveClass('semiont-annotation-pulse');
    });
  });

  describe('Focus state', () => {
    it('should set data-focused to true when focused', () => {
      const { container } = renderWithProviders(
        <TagEntry {...defaultProps} isFocused={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'true');
    });

    it('should set data-type to tag', () => {
      const { container } = renderWithProviders(<TagEntry {...defaultProps} />);

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-type', 'tag');
    });
  });
});
