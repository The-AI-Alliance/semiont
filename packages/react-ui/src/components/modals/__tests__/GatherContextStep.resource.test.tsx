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
  graphPaneTitle: 'In the graph',
  graphEmpty: 'No links yet — resolving this reference creates the first.',
  corpusPaneTitle: 'In the corpus',
  corpusEmpty: 'Nothing similar in the corpus.',
  excludedReceipt: '{{types}} excluded from this recall',
  machineRead: 'OCR',
  score: 'Score',
};

/** Post-P3 wire shape: resourceName required, entityTypes/machineRead optional. */
const MATCHES = [
  { text: 'a middling passage', resourceId: 'r-mid', resourceName: 'Middling Doc', score: 0.55 },
  { text: 'the best passage', resourceId: 'r-best', resourceName: 'Best Doc', score: 0.91,
    entityTypes: ['Battle'], machineRead: true },
  { text: 'a weak passage', resourceId: 'r-weak', resourceName: 'Weak Doc', score: 0.12 },
];

function withSemantic(ctx: GatheredContext, over: Record<string, unknown> = {}): GatheredContext {
  return {
    ...(ctx as object),
    semanticContext: { similar: MATCHES, excludedEntityTypes: ['Question'], ...over },
    inferredRelationshipSummary: 'Cedar County sits inside the Black Hawk Purchase.',
  } as unknown as GatheredContext;
}

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
    userHintEffect: 'steers Search and Generate',
    userHintPlaceholder: 'hint…',
  },
};

function resourceContext(): GatheredContext {
  return {
    focus: {
      kind: 'resource',
      resource: { '@id': 'res-1', name: 'My Resource' },
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

  // ── GEP P2 — the evidence panes ─────────────────────────────────────────────

  it('the graph pane shows its title and the inferred summary as prose header (P2)', () => {
    const { container } = render(
      <GatherContextStep
        context={withSemantic(resourceContext())}
        contextLoading={false} contextError={null} translations={t}
      />,
    );
    const pane = container.querySelector('.semiont-gather-pane--graph');
    expect(pane).not.toBeNull();
    expect(pane!.textContent).toContain('In the graph');
    expect(pane!.textContent).toContain('Cedar County sits inside the Black Hawk Purchase.');
  });

  it('the corpus pane ranks match cards by descending score, named and marked (P2, D4)', () => {
    const { container } = render(
      <GatherContextStep
        context={withSemantic(resourceContext())}
        contextLoading={false} contextError={null} translations={t}
      />,
    );
    const cards = Array.from(container.querySelectorAll('.semiont-corpus__card'));
    expect(cards).toHaveLength(3);
    // Descending by score, whatever order the wire delivered.
    expect(cards.map((c) => c.querySelector('.semiont-corpus__source')!.textContent))
      .toEqual(['Best Doc', 'Middling Doc', 'Weak Doc']);
    // The card names its source (D9's required field), shows the snippet, and
    // formats the 0–1 cosine to two places (logged deviation — the search step's
    // raw render is a different scale).
    expect(cards[0]!.textContent).toContain('the best passage');
    expect(cards[0]!.textContent).toContain('0.91');
    // Match-level entityTypes are tokens — chips on the card.
    expect(cards[0]!.querySelector('.semiont-chip')!.textContent).toBe('Battle');
    // machineRead is a trust marker that appears ONLY when the flag travels.
    expect(cards[0]!.textContent).toContain('OCR');
    expect(cards[1]!.textContent).not.toContain('OCR');
  });

  it('the exclusion receipt renders when present, and only then (P2, D4)', () => {
    const { container, rerender } = render(
      <GatherContextStep
        context={withSemantic(resourceContext())}
        contextLoading={false} contextError={null} translations={t}
      />,
    );
    expect(container.querySelector('.semiont-corpus__receipt')!.textContent)
      .toContain('Question excluded from this recall');

    rerender(
      <GatherContextStep
        context={withSemantic(resourceContext(), { excludedEntityTypes: [] })}
        contextLoading={false} contextError={null} translations={t}
      />,
    );
    expect(container.querySelector('.semiont-corpus__receipt')).toBeNull();
  });

  it('emptiness is evidence: each pane renders its empty-state copy (P2, D1)', () => {
    // resourceContext() has no semanticContext and a graph whose views resolve
    // to a connection — so build a truly empty context for both panes.
    const empty = {
      ...(resourceContext() as object),
      graph: { nodes: [], edges: [] },
    } as unknown as GatheredContext;
    const { container } = render(
      <GatherContextStep context={empty} contextLoading={false} contextError={null} translations={t} />,
    );
    expect(container.querySelector('.semiont-gather-pane--graph')!.textContent)
      .toContain('No links yet');
    expect(container.querySelector('.semiont-gather-pane--corpus')!.textContent)
      .toContain('Nothing similar in the corpus.');
  });

  it('the hint sits OUTSIDE the pane grid, full width above the footer (P2, D5)', () => {
    const { container } = render(
      <GatherContextStep
        context={annotationContext()}
        contextLoading={false} contextError={null}
        annotate={annotate} translations={t}
      />,
    );
    const textarea = container.querySelector('.semiont-gather__hint-textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.closest('.semiont-gather__body')).toBeNull(); // out of the grid
    expect(container.querySelector('.semiont-gather__hint-row')).not.toBeNull();
  });

  // ── GEP P4 — the graph pane's body is an actual graph ───────────────────────
  // Post-P3 topology: a citation is its linking ANNOTATION (annotation-of → the
  // citing resource, cites → the focal one); siblings are annotations ON the
  // focal resource. The viz draws the derived neighborhood: focal + peers +
  // citers + siblings; the citation's intermediary annotation collapses into
  // its edge.

  function vizContext(): GatheredContext {
    return {
      ...(resourceContext() as object),
      graph: {
        nodes: [
          { id: 'res-1', type: 'resource', label: 'My Resource' },
          { id: 'res-2', type: 'resource', label: 'Peer Doc', entityTypes: ['Topic'] },
          { id: 'res-3', type: 'resource', label: 'Citing Doc' },
          { id: 'ann-c', type: 'annotation', label: 'linking',
            annotation: { id: 'ann-c', motivation: 'linking' } },
          { id: 'ann-s', type: 'annotation', label: 'commenting', entityTypes: ['Person'],
            annotation: { id: 'ann-s', motivation: 'commenting',
              target: { source: 'res-1', selector: [
                { type: 'TextPositionSelector', start: 5, end: 22 },
                { type: 'TextQuoteSelector', exact: 'the disputed span' },
              ] },
              body: [
                { type: 'TextualBody', value: 'Person', purpose: 'tagging' },
                { type: 'TextualBody', value: 'a sibling note' },
              ] } },
        ],
        edges: [
          { source: 'res-1', target: 'res-2', type: 'related', bidirectional: true },
          { source: 'ann-c', target: 'res-3', type: 'annotation-of' },
          { source: 'ann-c', target: 'res-1', type: 'cites' },
          { source: 'ann-s', target: 'res-1', type: 'annotation-of' },
        ],
      },
    } as unknown as GatheredContext;
  }

  function renderViz() {
    return render(
      <GatherContextStep
        context={vizContext()} contextLoading={false} contextError={null} translations={t}
      />,
    );
  }

  it('draws the neighborhood as SVG — the interim lists are gone (P4, D3)', () => {
    const { container } = renderViz();
    const pane = container.querySelector('.semiont-gather-pane--graph')!;
    expect(pane.querySelector('svg')).not.toBeNull();
    // focal + peer + citer + sibling; the citing annotation collapses into its edge
    expect(pane.querySelectorAll('.semiont-graph__node')).toHaveLength(4);
    expect(pane.querySelectorAll('.semiont-graph__edge')).toHaveLength(3);
    expect(pane.querySelector('ul')).toBeNull(); // replaced, not joined
    // cited-by count stays visible WITHOUT hover
    expect(pane.textContent).toContain('Cited by (1)');
  });

  it('the focal node is visually distinct, and there is exactly one (P4)', () => {
    const { container } = renderViz();
    const focal = container.querySelectorAll('.semiont-graph__node--focal');
    expect(focal).toHaveLength(1);
    expect(focal[0]!.textContent).toContain('My Resource');
  });

  it('siblings are labeled by their quoted text — motivation and note stay in hover (P4, D11)', () => {
    // A node that just says "linking" is uninterpretable; the annotation's
    // identity is the text it wraps (TextQuoteSelector.exact, on the embedded
    // W3C annotation). Motivation is conveyed by the node's styling and hover.
    const { container } = renderViz();
    const sibling = container.querySelector('[data-node-id="ann-s"]');
    expect(sibling).not.toBeNull();
    expect(sibling!.querySelector('text')!.textContent).toBe('the disputed span');
    const title = sibling!.querySelector('title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain('commenting');
    expect(title!.textContent).toContain('a sibling note');
    // The tagging-purpose body is the entity-type tag — hover lists the type
    // ONCE (from entityTypes), not again as a body value.
    expect(title!.textContent!.match(/Person/g)).toHaveLength(1);
    // Peer hover carries its entity types.
    expect(container.querySelector('[data-node-id="res-2"] title')!.textContent).toContain('Topic');
  });

  it('layout is deterministic — same context, same positions (P4, D3)', () => {
    const positions = () => {
      const { container, unmount } = renderViz();
      const snap = Array.from(container.querySelectorAll('.semiont-graph__node rect'))
        .map((r) => `${r.closest('[data-node-id]')!.getAttribute('data-node-id')}@${r.getAttribute('x')},${r.getAttribute('y')}`)
        .join('|');
      unmount();
      return snap;
    };
    const first = positions();
    expect(first.length).toBeGreaterThan(0);
    expect(positions()).toBe(first);
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
      sourceResource: { '@id': 'res-1', name: 'Host' },
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
