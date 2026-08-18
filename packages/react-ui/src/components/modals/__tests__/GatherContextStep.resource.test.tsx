/**
 * GENERATE-FROM-BUTTON P1 — the GatheredContext display renders a resource focus.
 *
 * ContextSummary's graph views are focus-agnostic; GatherContextStep gains a
 * resource-focus strip and hides the annotation-only controls (hint + the
 * Bind/Generate/Compose footer) for a resource focus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { GatheredContext } from '@semiont/core';
import { GatherContextStep } from '../GatherContextStep';
import { ContextSummary } from '../ContextSummary';

const t = {
  loadingContext: 'Loading…',
  failedContext: 'Failed',
  sourceContextLabel: 'Source',
  connectionsLabel: 'Connections',
  citedByLabel: 'Cited by',
};

/** The annotation-wizard controls travel as ONE optional group (GFR D2). */
const annotate = {
  userHint: '',
  onUserHintChange: () => {},
  onBind: () => {},
  onGenerate: () => {},
  onCompose: () => {},
  translations: {
    search: 'Search',
    generate: 'Generate',
    compose: 'Compose',
    resolutionStrategyLabel: 'Strategy',
    userHintLabel: 'Hint',
    userHintPlaceholder: 'hint…',
  },
};

function resourceContext(): GatheredContext {
  return {
    focus: {
      kind: 'resource',
      resource: { id: 'res-1', name: 'My Resource' },
      summary: 'A short summary',
      suggestedReferences: ['Suggested Topic'],
      content: { main: 'main content' },
    },
    graph: {
      nodes: [
        { id: 'res-1', type: 'resource', label: 'My Resource' },
        { id: 'res-2', type: 'resource', label: 'Related Resource', entityTypes: ['Topic'] },
      ],
      edges: [{ source: 'res-1', target: 'res-2', type: 'peer' }],
    },
    metadata: { entityTypes: ['Topic'] },
  } as unknown as GatheredContext;
}

describe('GatheredContext display — resource focus', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView — GatherContextStep's annotation
    // strip calls it on mount. (Same stub the panel tests use.)
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('ContextSummary renders graph views (connections) for a resource focus', () => {
    const { container } = render(<ContextSummary context={resourceContext()} translations={t} />);
    expect(container.textContent).toContain('Related Resource'); // peer connection from deriveViews
  });

  it('GatherContextStep shows the resource strip and hides the annotation-only footer', () => {
    const { container } = render(
      <GatherContextStep
        context={resourceContext()}
        contextLoading={false}
        contextError={null}
        translations={t}
      />,
    );
    expect(container.textContent).toContain('My Resource');     // focal resource name
    expect(container.textContent).toContain('A short summary'); // resource summary
    expect(container.textContent).toContain('Suggested Topic'); // suggestedReferences entry
    expect(container.textContent).toContain('Related Resource'); // graph view via ContextSummary
    // annotation-only controls are gated out for a resource focus
    expect(container.textContent).not.toContain('Strategy');
    expect(container.querySelector('.semiont-gather__footer')).toBeNull();
    expect(container.querySelector('.semiont-gather__hint-textarea')).toBeNull();
  });

  it('GatherContextStep still shows the footer for an annotation focus', () => {
    const { container } = render(
      <GatherContextStep
        context={annotationContext()}
        contextLoading={false}
        contextError={null}
        annotate={annotate}
        translations={t}
      />,
    );
    expect(container.querySelector('.semiont-gather__footer')).not.toBeNull();
    expect(container.textContent).toContain('Strategy');
  });

  it('the quotation is contiguous prose — nothing interleaved, no monospace (GEP P1a, D6/D7)', () => {
    // The live bug: chips injected between `text` and `after` rendered
    // "Black Hawk [Person] [linking]'s band." — metadata interrupting the
    // quotation it describes, mid-possessive.
    const { container } = render(
      <GatherContextStep
        context={annotationContextWithTypes()}
        contextLoading={false}
        contextError={null}
        annotate={annotate}
        translations={t}
      />,
    );
    const quote = container.querySelector('.semiont-gather__source-context');
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toBe('a term b'); // before + text + after, verbatim
    // D7: quoted document prose, not code.
    expect(quote!.querySelector('[style*="monospace"]')).toBeNull();
  });

  it('metadata sits on the label row; the span WEARS its motivation (GEP P1b, D6)', () => {
    const { container } = render(
      <GatherContextStep
        context={annotationContextWithTypes()}
        contextLoading={false}
        contextError={null}
        annotate={annotate}
        translations={t}
      />,
    );
    const strip = container.querySelector('.semiont-gather__source-strip')!;

    // Entity chips are tokens — they live on the label row, outside the quotation.
    const chips = Array.from(strip.querySelectorAll('.semiont-chip'));
    const topicChip = chips.find((c) => c.textContent === 'Topic');
    expect(topicChip).toBeDefined();
    expect(topicChip!.closest('.semiont-gather__source-context')).toBeNull();

    // Motivation is WORN, never labeled: no chip says 'linking' —
    expect(chips.filter((c) => c.textContent === 'linking')).toEqual([]);
    // — the selected span carries the viewer's own class for the motivation
    // (the registry's applied name; the motivation stylesheets declare it as a
    // synonym of `semiont-motivation-reference`), with the hand-rolled inline
    // highlight gone.
    const span = strip.querySelector('.annotation-reference') as HTMLElement | null;
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('term');
    expect(span!.style.backgroundColor).toBe('');

    // Exactly ONE motivation-classed element: the context can place only the
    // focal annotation, and the strip must not show more (D6 boundary).
    const motivated = strip.querySelectorAll(
      '.annotation-reference, .annotation-highlight, .annotation-comment, .annotation-assessment, .annotation-tag',
    );
    expect(motivated).toHaveLength(1);
  });

  it('suggestedReferences render as a prose list, never chips (GFR A3)', () => {
    // The live values are full research prompts — sentences. The chip vocabulary
    // stays for tokens (entity types, categories, counts); a pill that wraps
    // across three lines is not a pill (GENERATE-FROM-RESOURCE D3).
    const { container } = render(
      <GatherContextStep
        context={resourceContext()}
        contextLoading={false}
        contextError={null}
        translations={t}
      />,
    );
    const item = Array.from(container.querySelectorAll('li'))
      .find((el) => el.textContent === 'Suggested Topic');
    expect(item).toBeDefined();
    expect(item!.className).not.toContain('semiont-chip');
    // The entity-type tokens beside the summary stay chips.
    const chipTexts = Array.from(container.querySelectorAll('.semiont-chip')).map((el) => el.textContent);
    expect(chipTexts).toContain('Topic');
    expect(chipTexts).not.toContain('Suggested Topic');
  });

  it('an annotation focus WITHOUT the annotate group renders display-only (GFR A2)', () => {
    // The resolution controls belong to the caller that can serve them. A
    // display-only caller must never get a hint textarea wired to nothing —
    // which is what the old always-on gate produced for an annotation focus.
    const { container } = render(
      <GatherContextStep
        context={annotationContext()}
        contextLoading={false}
        contextError={null}
        translations={t}
      />,
    );
    expect(container.querySelector('.semiont-gather__footer')).toBeNull();
    expect(container.querySelector('.semiont-gather__hint-textarea')).toBeNull();
  });
});

function annotationContext(): GatheredContext {
  return {
    focus: {
      kind: 'annotation',
      annotation: { id: 'anno-1', motivation: 'linking' },
      sourceResource: { id: 'res-1', name: 'Host' },
      selected: { before: 'a ', text: 'term', after: ' b' },
    },
    graph: { nodes: [], edges: [] },
    metadata: {},
  } as unknown as GatheredContext;
}

/** Same annotation focus, with anchor entity types — the GEP P1 chip fixtures. */
function annotationContextWithTypes(): GatheredContext {
  const ctx = annotationContext() as GatheredContext & { metadata: { entityTypes?: string[] } };
  ctx.metadata = { entityTypes: ['Topic'] };
  return ctx;
}
