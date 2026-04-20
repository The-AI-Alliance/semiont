/**
 * Triangulation test for the VM → useObservable → prop → chip render chain.
 *
 * Written after an e2e failure (test 05) where `ReferencesPanel` rendered
 * "No entity types available" even though the client provably received a
 * 9-string entity-types array from the backend.
 *
 * This test closes the Layer 5-6 gap: the existing `ResourceViewerPage.test.tsx`
 * stubs `UnifiedAnnotationsPanel`/`ReferencesPanel` as `<div data-testid>`s,
 * so it never verifies that an observable emitting [9 strings] actually
 * produces 9 chips in the DOM. This test does.
 *
 * If this test passes and the e2e still fails, the bug is further upstream
 * (BrowseNamespace wiring, multiple ApiClient instances, SSE delivery).
 * If it fails, the bug is here in component-land.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BehaviorSubject } from 'rxjs';
import { ReferencesPanel } from '../ReferencesPanel';
import { createTestSemiontWrapper } from '../../../../test-utils';
import { useObservable } from '../../../../hooks/useObservable';

// Match ReferencesPanel.test.tsx's i18n mocking so the test doesn't
// depend on a real translation setup.
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      title: 'References',
      annotateReferences: 'Annotate References',
      entityTypesOptional: 'Entity types',
      noEntityTypes: 'No entity types available',
      selectEntityTypes: 'Select entity types',
      includeDescriptiveReferences: 'Include descriptive references',
      cancel: 'Cancel',
      createReference: 'Create Reference',
      outgoingReferences: 'Outgoing References',
      incomingReferences: 'Incoming References',
      noIncomingReferences: 'No incoming references',
      fragmentSelected: 'Fragment selected',
      annotate: 'Annotate',
      start: 'Start',
    };
    return map[key] ?? key;
  },
}));

vi.mock('../AssistSection', () => ({
  AssistSection: () => null,
  AnnotateReferencesProgressWidget: () => null,
}));

const NINE_TYPES = [
  'Author', 'Concept', 'Date', 'Event', 'Location',
  'Organization', 'Person', 'Product', 'Technology',
];

const MockLink: React.FC<{ href?: string; children?: React.ReactNode }> = ({ children }) => <>{children}</>;
const mockRoutes = { resourceDetail: (id: string) => `/resource/${id}` } as any;

/**
 * Thin harness: subscribes to a BehaviorSubject via useObservable (the
 * same hook ResourceViewerPage uses for vm.entityTypes$) and forwards
 * its value into ReferencesPanel as `allEntityTypes`.
 */
function ObservableHarness({ source$ }: { source$: BehaviorSubject<string[]> }) {
  const entityTypes = useObservable(source$) ?? [];
  return (
    <ReferencesPanel
      annotations={[]}
      isAssisting={false}
      progress={null}
      annotateMode={true}
      Link={MockLink}
      routes={mockRoutes}
      allEntityTypes={entityTypes}
      pendingAnnotation={{
        motivation: 'linking',
        selector: { type: 'TextQuoteSelector', exact: 'te' },
      } as any}
    />
  );
}

const renderWithBus = (ui: React.ReactElement) => {
  const { SemiontWrapper } = createTestSemiontWrapper();
  return render(<SemiontWrapper>{ui}</SemiontWrapper>);
};

describe('Layer 5-6 — VM observable → useObservable → ReferencesPanel chips', () => {
  it('an observable seeded with [9 strings] renders 9 pending-reference chips', async () => {
    const source$ = new BehaviorSubject<string[]>(NINE_TYPES);
    renderWithBus(<ObservableHarness source$={source$} />);

    // Wait for useEffect in useObservable to run and commit the value.
    const chips = await screen.findAllByRole('button', { name: (_, el) =>
      el.classList.contains('semiont-tag-selector__item') ?? false,
    });
    expect(chips).toHaveLength(NINE_TYPES.length);
  });

  it('transition [] → [9 strings] re-renders with 9 chips', async () => {
    // This is the production timeline: the Cache emits undefined (mapped
    // to []) first, then the 9-string array once fetch resolves. The
    // prop chain must survive this transition.
    const source$ = new BehaviorSubject<string[]>([]);
    renderWithBus(<ObservableHarness source$={source$} />);

    // Initially: no chips (the gate is allEntityTypes.length > 0).
    expect(document.querySelectorAll('.semiont-tag-selector__item').length).toBe(0);

    await act(async () => {
      source$.next(NINE_TYPES);
      // Let useObservable's setState flush.
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(document.querySelectorAll('.semiont-tag-selector__item').length).toBe(NINE_TYPES.length);
  });

  it('[9 strings] with duplicate emissions (simulating SSE-duplicate deliveries) renders 9 chips', async () => {
    // The failing e2e run showed the same correlationId delivered 3x due
    // to concurrent SSE streams. Same data, but multiple BehaviorSubject
    // writes. Must not clobber the render.
    const source$ = new BehaviorSubject<string[]>([]);
    renderWithBus(<ObservableHarness source$={source$} />);

    await act(async () => {
      source$.next(NINE_TYPES);
      source$.next([...NINE_TYPES]); // same content, new reference
      source$.next([...NINE_TYPES]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(document.querySelectorAll('.semiont-tag-selector__item').length).toBe(NINE_TYPES.length);
  });

  it('no regression: [] still renders "No entity types available"', () => {
    // Confirms the control case: an empty observable does render the
    // message the failing e2e saw. Guards against the test passing
    // trivially because of a selector bug.
    const source$ = new BehaviorSubject<string[]>([]);
    renderWithBus(<ObservableHarness source$={source$} />);

    // There are two such text nodes in the panel (pending prompt + assist
    // section), but both correspond to the same allEntityTypes=[] state.
    const msg = screen.queryAllByText(/no entity types available/i);
    expect(msg.length).toBeGreaterThan(0);
  });
});
