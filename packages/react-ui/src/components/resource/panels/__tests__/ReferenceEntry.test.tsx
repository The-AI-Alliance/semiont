import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import type { components } from '@semiont/core';
import type { RouteBuilder } from '../../../../contexts/RoutingContext';

type Annotation = components['schemas']['Annotation'];

// Stable mock functions defined outside vi.mock to avoid re-render loops
const mockGetAnnotationExactText = vi.fn();
const mockIsBodyResolved = vi.fn();
const mockGetBodySource = vi.fn();
const mockGetFragmentSelector = vi.fn();
const mockGetSvgSelector = vi.fn();
const mockGetTargetSelector = vi.fn();
const mockGetEntityTypes = vi.fn();
const mockNavigate = vi.fn();
const mockHoverProps = { onMouseEnter: vi.fn(), onMouseLeave: vi.fn() };

vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getAnnotationExactText: (...args: unknown[]) => mockGetAnnotationExactText(...args),
    isBodyResolved: (...args: unknown[]) => mockIsBodyResolved(...args),
    getBodySource: (...args: unknown[]) => mockGetBodySource(...args),
    getFragmentSelector: (...args: unknown[]) => mockGetFragmentSelector(...args),
    getSvgSelector: (...args: unknown[]) => mockGetSvgSelector(...args),
    getTargetSelector: (...args: unknown[]) => mockGetTargetSelector(...args),
  };
});

vi.mock('@semiont/ontology', () => ({
  getEntityTypes: (...args: unknown[]) => mockGetEntityTypes(...args),
}));

vi.mock('../../../../lib/resource-utils', () => ({
  getResourceIcon: vi.fn(() => '📄'),
}));

vi.mock('../../../../hooks/useObservableBrowse', () => ({
  useObservableExternalNavigation: () => mockNavigate,
}));

vi.mock('../../../../hooks/useBeckonFlow', () => ({
  useHoverEmitter: () => mockHoverProps,
}));

import { ReferenceEntry } from '../ReferenceEntry';

const createMockReference = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'ref-1',
  type: 'Annotation',
  motivation: 'linking',
  created: '2024-06-15T12:00:00Z',
  modified: '2024-06-15T12:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextQuoteSelector',
      exact: 'referenced text',
    },
  },
  body: {
    type: 'SpecificResource',
    source: 'linked-doc',
  },
  ...overrides,
});

const mockRoutes: RouteBuilder = {
  resourceDetail: vi.fn((id: string) => `/resources/${id}`),
  resourceList: vi.fn(() => '/resources'),
};

describe('ReferenceEntry', () => {
  const defaultProps = {
    reference: createMockReference(),
    isFocused: false,
    routes: mockRoutes,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnnotationExactText.mockReturnValue('referenced text');
    mockIsBodyResolved.mockReturnValue(false);
    mockGetBodySource.mockReturnValue(null);
    mockGetTargetSelector.mockReturnValue(null);
    mockGetFragmentSelector.mockReturnValue(null);
    mockGetSvgSelector.mockReturnValue(null);
    mockGetEntityTypes.mockReturnValue([]);
  });

  describe('Rendering', () => {
    it('should render the selected text in quotes', () => {
      renderWithProviders(<ReferenceEntry {...defaultProps} />);

      expect(screen.getByText(/referenced text/)).toBeInTheDocument();
    });

    it('should truncate text over 100 characters', () => {
      const longText = 'A'.repeat(150);
      mockGetAnnotationExactText.mockReturnValue(longText);

      renderWithProviders(<ReferenceEntry {...defaultProps} />);

      expect(screen.getByText(new RegExp(`"${'A'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should show stub icon when reference is not resolved', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toBeInTheDocument();
      expect(icon!.textContent).toContain('❓');
    });

    it('should show link icon when reference is resolved', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toBeInTheDocument();
      expect(icon!.textContent).toContain('🔗');
    });

    it('should show annotation type when no selected text', () => {
      mockGetAnnotationExactText.mockReturnValue('');

      renderWithProviders(<ReferenceEntry {...defaultProps} />);

      expect(screen.getByText('Annotation')).toBeInTheDocument();
    });

    it('should show Fragment annotation for fragment selectors', () => {
      mockGetAnnotationExactText.mockReturnValue('');
      mockGetFragmentSelector.mockReturnValue({ type: 'FragmentSelector', value: 'xywh=0,0,100,100' });

      renderWithProviders(<ReferenceEntry {...defaultProps} />);

      expect(screen.getByText('Fragment annotation')).toBeInTheDocument();
    });

    it('should show Image annotation for SVG selectors', () => {
      mockGetAnnotationExactText.mockReturnValue('');
      mockGetSvgSelector.mockReturnValue({ type: 'SvgSelector', value: '<svg/>' });

      renderWithProviders(<ReferenceEntry {...defaultProps} />);

      expect(screen.getByText('Image annotation')).toBeInTheDocument();
    });

    it('should render resolved document name when enriched', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const enrichedRef = {
        ...createMockReference(),
        _resolvedDocumentName: 'My Linked Document',
        _resolvedDocumentMediaType: 'text/plain',
      };

      renderWithProviders(<ReferenceEntry {...defaultProps} reference={enrichedRef as Annotation} />);

      expect(screen.getByText(/My Linked Document/)).toBeInTheDocument();
    });
  });

  describe('Entity types', () => {
    it('should render entity type badges', () => {
      mockGetEntityTypes.mockReturnValue(['Person', 'Organization']);

      renderWithProviders(<ReferenceEntry {...defaultProps} />);

      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
    });

    it('should not render entity type section when empty', () => {
      mockGetEntityTypes.mockReturnValue([]);

      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      expect(container.querySelector('.semiont-annotation-entry__tags')).not.toBeInTheDocument();
    });
  });

  describe('Focus and hover state', () => {
    it('should set data-focused to true when focused', () => {
      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} isFocused={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'true');
    });

    it('should set data-focused to false when not focused', () => {
      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} isFocused={false} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'false');
    });

    it('should apply pulse class when isHovered is true', () => {
      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} isHovered={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveClass('semiont-annotation-pulse');
    });

    it('should not apply pulse class when isHovered is false', () => {
      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} isHovered={false} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).not.toHaveClass('semiont-annotation-pulse');
    });
  });

  describe('Click events', () => {
    it('should emit browse:click on click', async () => {
      const clickHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <ReferenceEntry {...defaultProps} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('browse:click').subscribe(clickHandler);

      const entry = container.firstChild as HTMLElement;
      await userEvent.click(entry);

      expect(clickHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
        motivation: 'linking',
      });

      subscription.unsubscribe();
    });
  });

  describe('Status icon — resolved reference', () => {
    it('should navigate on 🔗 icon click', async () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      const icon = container.querySelector('.semiont-reference-icon')!;
      await userEvent.click(icon);

      expect(mockRoutes.resourceDetail).toHaveBeenCalledWith('linked-doc');
      expect(mockNavigate).toHaveBeenCalledWith('/resources/linked-doc', { resourceId: 'linked-doc' });
    });

    it('should have clickable class when resolved', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toHaveClass('semiont-reference-icon--clickable');
    });

    it('should show hover-reveal unlink button in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />
      );

      const unlinkButton = container.querySelector('.semiont-reference-unlink');
      expect(unlinkButton).toBeInTheDocument();
    });

    it('should not show unlink button when not in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={false} />
      );

      const unlinkButton = container.querySelector('.semiont-reference-unlink');
      expect(unlinkButton).not.toBeInTheDocument();
    });

    it('should emit bind:update-body on unlink click', async () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');
      const unlinkHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('bind:update-body').subscribe(unlinkHandler);

      const unlinkButton = container.querySelector('.semiont-reference-unlink')!;
      await userEvent.click(unlinkButton);

      expect(unlinkHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
        resourceId: 'resource-1',
        operations: [{ op: 'remove', item: { type: 'SpecificResource', source: 'linked-doc' } }],
      });

      subscription.unsubscribe();
    });
  });

  describe('Status icon — stub reference', () => {
    it('should emit bind:initiate on ❓ icon click in annotate mode', async () => {
      mockIsBodyResolved.mockReturnValue(false);
      mockGetEntityTypes.mockReturnValue(['Person']);
      const initiateHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('bind:initiate').subscribe(initiateHandler);

      const icon = container.querySelector('.semiont-reference-icon')!;
      await userEvent.click(icon);

      expect(initiateHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
        resourceId: 'resource-1',
        defaultTitle: 'referenced text',
        entityTypes: ['Person'],
      });

      subscription.unsubscribe();
    });

    it('should have clickable class in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />
      );

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toHaveClass('semiont-reference-icon--clickable');
    });

    it('should not be clickable in browse mode', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={false} />
      );

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).not.toHaveClass('semiont-reference-icon--clickable');
    });

    it('should not emit bind:initiate on ❓ icon click in browse mode', async () => {
      mockIsBodyResolved.mockReturnValue(false);
      const initiateHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={false} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('bind:initiate').subscribe(initiateHandler);

      const icon = container.querySelector('.semiont-reference-icon')!;
      await userEvent.click(icon);

      expect(initiateHandler).not.toHaveBeenCalled();

      subscription.unsubscribe();
    });
  });

  describe('data-type attribute', () => {
    it('should have data-type="reference"', () => {
      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-type', 'reference');
    });
  });
});
