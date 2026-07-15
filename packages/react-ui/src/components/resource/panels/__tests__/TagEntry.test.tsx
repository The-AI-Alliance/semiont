import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cloneElement, type ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { of } from 'rxjs';
import { CacheObservable, type SemiontSession } from '@semiont/sdk';
import { renderWithProviders, createTestSemiontWrapper } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import type { TagSchema } from '@semiont/core';

import type { Annotation, AnnotationId } from '@semiont/core';

// Mock @semiont/http-transport
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
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

import { getAnnotationExactText } from '@semiont/core';
import { getTagCategory, getTagSchemaId } from '@semiont/ontology';
import type { MockedFunction } from 'vitest';
import { TagEntry } from '../TagEntry';

const mockGetAnnotationExactText = getAnnotationExactText as MockedFunction<typeof getAnnotationExactText>;
const mockGetTagCategory = getTagCategory as MockedFunction<typeof getTagCategory>;
const mockGetTagSchemaId = getTagSchemaId as MockedFunction<typeof getTagSchemaId>;


const createMockTag = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'tag-1' as AnnotationId,
  type: 'Annotation',
  motivation: 'tagging',
  creator: {
    '@type': 'Person',
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
    // Satisfies JSX at element construction only; render helpers/tests pass
    // the real per-test factory session explicitly. Never put a live session
    // here — module-scope clients get disposed after the first test.
    session: null,
  };

  // The component is provider-free: hand it a fresh per-test fake session as
  // the `session` prop. renderWithProviders still supplies translations/toasts.
  const renderTagEntry = (element: ReactElement<{ session: SemiontSession | null }>) => {
    const { session } = createTestSemiontWrapper();
    return renderWithProviders(cloneElement(element, { session }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnnotationExactText.mockReturnValue('Tagged text content');
    mockGetTagCategory.mockReturnValue('Entity');
    mockGetTagSchemaId.mockReturnValue(undefined);
  });

  describe('Rendering', () => {
    it('should render the category badge', () => {
      renderTagEntry(<TagEntry {...defaultProps} />);

      expect(screen.getByText('Entity')).toBeInTheDocument();
    });

    it('should render the selected text in quotes', () => {
      renderTagEntry(<TagEntry {...defaultProps} />);

      expect(screen.getByText(/Tagged text content/)).toBeInTheDocument();
    });

    it('should truncate text over 150 characters', () => {
      const longText = 'C'.repeat(200);
      mockGetAnnotationExactText.mockReturnValue(longText);

      renderTagEntry(<TagEntry {...defaultProps} />);

      expect(screen.getByText(new RegExp(`"${'C'.repeat(150)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should not truncate text at exactly 150 characters', () => {
      const exactText = 'D'.repeat(150);
      mockGetAnnotationExactText.mockReturnValue(exactText);

      const { container } = renderTagEntry(<TagEntry {...defaultProps} />);

      const quote = container.querySelector('.semiont-annotation-entry__quote');
      expect(quote).toBeInTheDocument();
      expect(quote!.textContent).not.toContain('...');
    });

    it('should render schema name when available', () => {
      mockGetTagSchemaId.mockReturnValue('schema-ner-v1');
      const NER_SCHEMA: TagSchema = {
        id: 'schema-ner-v1',
        name: 'Named Entity Recognition',
        description: 'NER',
        domain: 'nlp',
        tags: [],
      };

      // Stub the cache to resolve immediately with the test schema —
      // exercises the rendering path without round-tripping through the
      // transport's HTTP plumbing.
      const { SemiontWrapper, client, session } = createTestSemiontWrapper();
      vi.spyOn(client.browse, 'tagSchemas').mockReturnValue(
        CacheObservable.from(of([NER_SCHEMA]))
      );
      render(<TagEntry {...defaultProps} session={session} />, { wrapper: SemiontWrapper });

      expect(screen.getByText('Named Entity Recognition')).toBeInTheDocument();
    });

    it('should not render schema name when schema is not found', () => {
      mockGetTagSchemaId.mockReturnValue('unknown-schema');

      // Stub the cache to resolve to an empty list — the schema lookup
      // misses, the schema-name `<span>` is not rendered.
      const { SemiontWrapper, client, session } = createTestSemiontWrapper();
      vi.spyOn(client.browse, 'tagSchemas').mockReturnValue(
        CacheObservable.from(of([]))
      );
      const { container } = render(<TagEntry {...defaultProps} session={session} />, { wrapper: SemiontWrapper });

      expect(container.querySelector('.semiont-annotation-entry__meta')).not.toBeInTheDocument();
    });

    it('should render category badge with correct data-variant', () => {
      const { container } = renderTagEntry(<TagEntry {...defaultProps} />);

      const badge = container.querySelector('.semiont-tag-badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute('data-variant', 'tag');
    });
  });

  describe('Interactions', () => {
    it('should emit browse:click on click', async () => {
      const clickHandler = vi.fn();

      // The session prop is the only session the provider-free component
      // sees — subscribe on the SAME factory's bus that backs it.
      const { session, eventBus } = createTestSemiontWrapper();
      const subscription = eventBus.get('browse:click').subscribe(clickHandler);

      const { container } = renderWithProviders(
        <TagEntry {...defaultProps} session={session} />
      );

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
      const { container } = renderTagEntry(
        <TagEntry {...defaultProps} isHovered={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveClass('semiont-annotation-pulse');
    });

    it('should not apply pulse class when isHovered is false', () => {
      const { container } = renderTagEntry(
        <TagEntry {...defaultProps} isHovered={false} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).not.toHaveClass('semiont-annotation-pulse');
    });
  });

  describe('Focus state', () => {
    it('should set data-focused to true when focused', () => {
      const { container } = renderTagEntry(
        <TagEntry {...defaultProps} isFocused={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'true');
    });

    it('should set data-type to tag', () => {
      const { container } = renderTagEntry(<TagEntry {...defaultProps} />);

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-type', 'tag');
    });
  });
});
