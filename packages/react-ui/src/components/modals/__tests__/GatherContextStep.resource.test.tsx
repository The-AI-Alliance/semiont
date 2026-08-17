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
