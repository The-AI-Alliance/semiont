import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, act } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import type { CacheState } from '@semiont/sdk';
import type { ResourceDescriptor } from '@semiont/core';
import { getResourceIcon } from '../../../../lib/resource-utils';
import '@testing-library/jest-dom';
import type { ComponentProps } from 'react';
import { renderWithProviders, createTestSemiontWrapper } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import { BindNamespace } from '@semiont/sdk';

import type { Annotation, AnnotationId } from '@semiont/core';

// Stable mock functions defined outside vi.mock to avoid re-render loops
const mockGetAnnotationExactText = vi.fn();
const mockIsBodyResolved = vi.fn();
const mockGetBodySource = vi.fn();
const mockGetFragmentSelector = vi.fn();
const mockGetSvgSelector = vi.fn();
const mockGetTargetSelector = vi.fn();
const mockGetEntityTypes = vi.fn();
const mockHoverProps = { onMouseEnter: vi.fn(), onMouseLeave: vi.fn() };

vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
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

vi.mock('../../../../hooks/useHoverEmitter', () => ({
  useHoverEmitter: () => mockHoverProps,
}));

import { ReferenceEntry } from '../ReferenceEntry';

const createMockReference = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'ref-1' as AnnotationId,
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

describe('ReferenceEntry', () => {
  // Provider-free component: the session prop is the only session it sees.
  // Created per-test — test-utils disposes registered clients in afterEach.
  let session: ReturnType<typeof createTestSemiontWrapper>['session'];
  let eventBus: ReturnType<typeof createTestSemiontWrapper>['eventBus'];

  const renderEntry = (props: Partial<ComponentProps<typeof ReferenceEntry>> = {}) =>
    renderWithProviders(
      <ReferenceEntry
        session={session}
        reference={createMockReference()}
        isFocused={false}
        {...props}
      />,
    );

  const descriptor = (name: string, mediaType = 'text/plain'): ResourceDescriptor => ({
    '@id': 'linked-doc',
    name,
    representations: [{ mediaType, checksum: 'c', byteSize: 1 }],
  }) as unknown as ResourceDescriptor;

  const ready = (value: ResourceDescriptor): CacheState<ResourceDescriptor> =>
    ({ status: 'ready', value });

  /** Point the session's resource cache at a controlled stream for the link target. */
  const mockLinkTarget = (state: CacheState<ResourceDescriptor> | BehaviorSubject<CacheState<ResourceDescriptor>>) => {
    const source$ = state instanceof BehaviorSubject ? state : new BehaviorSubject(state);
    return vi.spyOn(session!.client.browse, 'resource').mockReturnValue(source$ as never);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ({ session, eventBus } = createTestSemiontWrapper());
    mockGetAnnotationExactText.mockReturnValue('referenced text');
    mockIsBodyResolved.mockReturnValue(false);
    mockGetBodySource.mockReturnValue(null);
    mockGetTargetSelector.mockReturnValue(null);
    mockGetFragmentSelector.mockReturnValue(null);
    mockGetSvgSelector.mockReturnValue(null);
    mockGetEntityTypes.mockReturnValue([]);
  });

  // RESOLUTION-SPARKLE D6: a just-resolved reference announces itself on the
  // panel entry's icon with the same `.annotation-sparkle` glow the document
  // span uses. The host decides WHEN (membership in the sparkle set); the
  // entry only renders the boolean.
  describe('Resolution sparkle', () => {
    it('carries the sparkle animation on the icon when sparkle is set', () => {
      const { container } = renderEntry({ sparkle: true });

      expect(container.querySelector('.semiont-reference-icon')).toHaveClass('annotation-sparkle');
    });

    it('does not sparkle by default', () => {
      const { container } = renderEntry();

      expect(container.querySelector('.semiont-reference-icon')).not.toHaveClass('annotation-sparkle');
    });
  });

  describe('Rendering', () => {
    it('should render the selected text in quotes', () => {
      renderEntry();

      expect(screen.getByText(/referenced text/)).toBeInTheDocument();
    });

    it('should truncate text over 100 characters', () => {
      const longText = 'A'.repeat(150);
      mockGetAnnotationExactText.mockReturnValue(longText);

      renderEntry();

      expect(screen.getByText(new RegExp(`"${'A'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should show stub icon when reference is not resolved', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderEntry();

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toBeInTheDocument();
      expect(icon!.textContent).toContain('❓');
    });

    it('should show link icon when reference is resolved', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderEntry();

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toBeInTheDocument();
      expect(icon!.textContent).toContain('🔗');
    });

    it('should show annotation type when no selected text', () => {
      mockGetAnnotationExactText.mockReturnValue('');

      renderEntry();

      expect(screen.getByText('Annotation')).toBeInTheDocument();
    });

    it('should show Fragment annotation for fragment selectors', () => {
      mockGetAnnotationExactText.mockReturnValue('');
      mockGetFragmentSelector.mockReturnValue({ type: 'FragmentSelector', value: 'xywh=0,0,100,100' });

      renderEntry();

      expect(screen.getByText('Fragment annotation')).toBeInTheDocument();
    });

    it('should show Image annotation for SVG selectors', () => {
      mockGetAnnotationExactText.mockReturnValue('');
      mockGetSvgSelector.mockReturnValue({ type: 'SvgSelector', value: '<svg/>' });

      renderEntry();

      expect(screen.getByText('Image annotation')).toBeInTheDocument();
    });

    it('should render the resolved document name, read from the SDK resource cache', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');
      mockLinkTarget(ready(descriptor('My Linked Document', 'text/plain')));

      renderEntry();

      expect(screen.getByText(/My Linked Document/)).toBeInTheDocument();
    });

    it('a resource-level derivation headlines Derived, never the generic type label', () => {
      // The provenance edge minted by resource-focus generation: no selector
      // (nothing to quote), resolved body naming the derived resource. The
      // generic "Annotation" label said nothing — the qualifier says what
      // the entry IS; the link line below says what it points at. Inference
      // is from shape (the wire vocabulary deliberately has no 'deriving'
      // purpose); the unresolved case keeps the plain type label.
      mockGetAnnotationExactText.mockReturnValue('');
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('gen-doc');
      mockLinkTarget(ready(descriptor('generated from Cedar County, Iowa')));

      renderEntry({ reference: createMockReference({ target: { source: 'resource-1' } }) });

      expect(screen.getByText('ReferencesPanel.derived')).toBeInTheDocument();
      expect(screen.queryByText('Annotation')).not.toBeInTheDocument();
      expect(screen.getByText(/generated from Cedar County, Iowa/)).toBeInTheDocument();
    });
  });

  describe('Entity types', () => {
    it('should render entity type badges', () => {
      mockGetEntityTypes.mockReturnValue(['Person', 'Organization']);

      renderEntry();

      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
    });

    it('should not render entity type section when empty', () => {
      mockGetEntityTypes.mockReturnValue([]);

      const { container } = renderEntry();

      expect(container.querySelector('.semiont-annotation-entry__tags')).not.toBeInTheDocument();
    });
  });

  describe('Focus and hover state', () => {
    it('should set data-focused to true when focused', () => {
      const { container } = renderEntry({ isFocused: true });

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'true');
    });

    it('should set data-focused to false when not focused', () => {
      const { container } = renderEntry({ isFocused: false });

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'false');
    });

    it('should apply pulse class when isHovered is true', () => {
      const { container } = renderEntry({ isHovered: true });

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveClass('semiont-annotation-pulse');
    });

    it('should not apply pulse class when isHovered is false', () => {
      const { container } = renderEntry({ isHovered: false });

      const entry = container.firstChild as HTMLElement;
      expect(entry).not.toHaveClass('semiont-annotation-pulse');
    });
  });

  describe('Click events', () => {
    it('should emit browse:click on click', async () => {
      const clickHandler = vi.fn();

      const { container } = renderEntry();

      const subscription = eventBus.get('browse:click').subscribe(clickHandler);

      const entry = container.firstChild as HTMLElement;
      await userEvent.click(entry);

      expect(clickHandler).toHaveBeenCalledWith({
        annotationId: 'ref-1',
      });

      subscription.unsubscribe();
    });
  });

  describe('Status icon — resolved reference', () => {
    it('should call onOpenResource on 🔗 icon click', async () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');
      const onOpenResource = vi.fn();

      const { container } = renderEntry({ onOpenResource });

      const icon = container.querySelector('.semiont-reference-icon')!;
      await userEvent.click(icon);

      expect(onOpenResource).toHaveBeenCalledWith('linked-doc');
    });

    it('should have clickable class when resolved', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderEntry();

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toHaveClass('semiont-reference-icon--clickable');
    });

    it('should show hover-reveal unlink button in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderEntry({ annotateMode: true });

      const unlinkButton = container.querySelector('.semiont-reference-unlink');
      expect(unlinkButton).toBeInTheDocument();
    });

    it('should not show unlink button when not in annotate mode', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const { container } = renderEntry({ annotateMode: false });

      const unlinkButton = container.querySelector('.semiont-reference-unlink');
      expect(unlinkButton).not.toBeInTheDocument();
    });

    it('should call client.bind.body on unlink click', async () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const bindSpy = vi.spyOn(BindNamespace.prototype, 'body').mockResolvedValue(undefined);

      const { container } = renderEntry({ annotateMode: true });

      const unlinkButton = container.querySelector('.semiont-reference-unlink')!;
      await userEvent.click(unlinkButton);

      expect(bindSpy).toHaveBeenCalledWith(
        'resource-1',
        'ref-1',
        [{ op: 'remove', item: { type: 'SpecificResource', source: 'linked-doc', purpose: 'linking' } }],
      );

      bindSpy.mockRestore();
    });

    it('emits bind:body-error (resource-stamped, client-local) when unlink fails', async () => {
      // This component has no toast surface — its catch emits the client-local
      // bind error and useOutcomeToasts surfaces it. The raw
      // bind:body-update-failed wire reply is busRequest plumbing, not UI.
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      const bindSpy = vi.spyOn(BindNamespace.prototype, 'body').mockRejectedValue(new Error('link is load-bearing'));
      const errors: unknown[] = [];
      eventBus.get('bind:body-error').subscribe(e => errors.push(e));

      const { container } = renderEntry({ annotateMode: true });
      await userEvent.click(container.querySelector('.semiont-reference-unlink')!);

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toEqual({ resourceId: 'resource-1', message: 'link is load-bearing' });

      bindSpy.mockRestore();
    });
  });

  describe('Status icon — stub reference', () => {
    it('should emit bind:initiate on ❓ icon click in annotate mode', async () => {
      mockIsBodyResolved.mockReturnValue(false);
      mockGetEntityTypes.mockReturnValue(['Person']);
      const initiateHandler = vi.fn();

      const { container } = renderEntry({ annotateMode: true });

      const subscription = eventBus.get('bind:initiate').subscribe(initiateHandler);

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

      const { container } = renderEntry({ annotateMode: true });

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).toHaveClass('semiont-reference-icon--clickable');
    });

    it('should not be clickable in browse mode', () => {
      mockIsBodyResolved.mockReturnValue(false);

      const { container } = renderEntry({ annotateMode: false });

      const icon = container.querySelector('.semiont-reference-icon');
      expect(icon).not.toHaveClass('semiont-reference-icon--clickable');
    });

    it('should not emit bind:initiate on ❓ icon click in browse mode', async () => {
      mockIsBodyResolved.mockReturnValue(false);
      const initiateHandler = vi.fn();

      const { container } = renderEntry({ annotateMode: false });

      const subscription = eventBus.get('bind:initiate').subscribe(initiateHandler);

      const icon = container.querySelector('.semiont-reference-icon')!;
      await userEvent.click(icon);

      expect(initiateHandler).not.toHaveBeenCalled();

      subscription.unsubscribe();
    });
  });

  describe('data-type attribute', () => {
    it('should have data-type="reference"', () => {
      const { container } = renderEntry();

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-type', 'reference');
    });
  });

  // ANNOTATIONS-STAY-W3C P1: the annotation on the wire is exactly W3C — the
  // linked resource's name and media type are read from THAT resource through
  // the SDK's cache, where they are displayed. No `_resolved*` fields.
  describe('Link target resolved through the SDK', () => {
    it('shows name and media-type icon for a pure W3C annotation, sourced from browse.resource', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');
      const spy = mockLinkTarget(ready(descriptor('My Linked Document', 'text/markdown')));

      renderEntry();

      expect(screen.getByText(/My Linked Document/)).toBeInTheDocument();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(vi.mocked(getResourceIcon)).toHaveBeenCalledWith('text/markdown');
    });

    it('the name FOLLOWS the resource — a renamed descriptor re-renders the entry', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');
      const state$ = new BehaviorSubject<CacheState<ResourceDescriptor>>(ready(descriptor('Old Name')));
      mockLinkTarget(state$);

      renderEntry();
      expect(screen.getByText(/Old Name/)).toBeInTheDocument();

      act(() => state$.next(ready(descriptor('New Name'))));

      expect(screen.getByText(/New Name/)).toBeInTheDocument();
      expect(screen.queryByText(/Old Name/)).not.toBeInTheDocument();
    });

    it('a resource-level derivation headlines Derived BEFORE the name has loaded (keyed off isResolved)', () => {
      mockGetAnnotationExactText.mockReturnValue('');
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('gen-doc');
      mockLinkTarget(new BehaviorSubject<CacheState<ResourceDescriptor>>({ status: 'pending' }));

      renderEntry({ reference: createMockReference({ target: { source: 'resource-1' } }) });

      expect(screen.getByText('ReferencesPanel.derived')).toBeInTheDocument();
      expect(screen.queryByText('Annotation')).not.toBeInTheDocument();
    });

    it('a stub requests nothing — no browse.resource call for an unresolved reference', () => {
      mockIsBodyResolved.mockReturnValue(false);
      const spy = vi.spyOn(session!.client.browse, 'resource');

      renderEntry();

      expect(spy).not.toHaveBeenCalled();
    });

    it('a null session performs no lookup and renders without error', () => {
      mockIsBodyResolved.mockReturnValue(true);
      mockGetBodySource.mockReturnValue('linked-doc');

      renderEntry({ session: null });

      expect(screen.getByText(/referenced text/)).toBeInTheDocument();
    });
  });
});
