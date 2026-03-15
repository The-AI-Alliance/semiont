import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders, resetEventBusForTesting } from '../../../../test-utils';
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
    resetEventBusForTesting();
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

  describe('Resolved reference actions', () => {
    it('should show open button when resolved', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      const openButton = container.querySelector('button[title="ReferencesPanel.open"]');
      expect(openButton).toBeInTheDocument();
    });

    it('should show unlink button when resolved and in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />
      );

      const unlinkButton = container.querySelector('button[title="ReferencesPanel.unlink"]');
      expect(unlinkButton).toBeInTheDocument();
    });

    it('should not show unlink button when not in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={false} />
      );

      const unlinkButton = container.querySelector('button[title="ReferencesPanel.unlink"]');
      expect(unlinkButton).not.toBeInTheDocument();
    });

    it('should navigate on open click', async () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderWithProviders(<ReferenceEntry {...defaultProps} />);

      const openButton = container.querySelector('button[title="ReferencesPanel.open"]')!;
      await userEvent.click(openButton);

      expect(mockRoutes.resourceDetail).toHaveBeenCalledWith('linked-doc');
      expect(mockNavigate).toHaveBeenCalledWith('/resources/linked-doc', { resourceId: 'linked-doc' });
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

      const unlinkButton = container.querySelector('button[title="ReferencesPanel.unlink"]')!;
      await userEvent.click(unlinkButton);

      expect(unlinkHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
        resourceId: 'resource-1',
        operations: [{ op: 'remove' }],
      });

      subscription.unsubscribe();
    });
  });

  describe('Stub reference actions', () => {
    it('should show generate, search, and create buttons in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />
      );

      expect(container.querySelector('button[title="ReferencesPanel.generate"]')).toBeInTheDocument();
      expect(container.querySelector('button[title="ReferencesPanel.find"]')).toBeInTheDocument();
      expect(container.querySelector('button[title="ReferencesPanel.create"]')).toBeInTheDocument();
    });

    it('should not show stub actions when not in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={false} />
      );

      expect(container.querySelector('button[title="ReferencesPanel.generate"]')).not.toBeInTheDocument();
      expect(container.querySelector('button[title="ReferencesPanel.find"]')).not.toBeInTheDocument();
      expect(container.querySelector('button[title="ReferencesPanel.create"]')).not.toBeInTheDocument();
    });

    it('should emit yield:modal-open on generate click', async () => {
      mockIsBodyResolved.mockReturnValue(false);
      const generateHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('yield:modal-open').subscribe(generateHandler);

      const generateButton = container.querySelector('button[title="ReferencesPanel.generate"]')!;
      await userEvent.click(generateButton);

      expect(generateHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
        resourceId: 'resource-1',
        defaultTitle: 'referenced text',
      });

      subscription.unsubscribe();
    });

    it('should emit bind:link on search click', async () => {
      mockIsBodyResolved.mockReturnValue(false);
      const searchHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('bind:link').subscribe(searchHandler);

      const searchButton = container.querySelector('button[title="ReferencesPanel.find"]')!;
      await userEvent.click(searchButton);

      expect(searchHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
        resourceId: 'resource-1',
        searchTerm: 'referenced text',
      });

      subscription.unsubscribe();
    });

    it('should emit bind:create-manual on create click', async () => {
      mockIsBodyResolved.mockReturnValue(false);
      mockGetEntityTypes.mockReturnValue(['Person']);
      const createHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('bind:create-manual').subscribe(createHandler);

      const createButton = container.querySelector('button[title="ReferencesPanel.create"]')!;
      await userEvent.click(createButton);

      expect(createHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
        title: 'referenced text',
        entityTypes: ['Person'],
      });

      subscription.unsubscribe();
    });

    it('should set data-generating on generate button', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderWithProviders(
        <ReferenceEntry {...defaultProps} annotateMode={true} isGenerating={true} />
      );

      const generateButton = container.querySelector('button[title="ReferencesPanel.generate"]');
      expect(generateButton).toHaveAttribute('data-generating', 'true');
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
