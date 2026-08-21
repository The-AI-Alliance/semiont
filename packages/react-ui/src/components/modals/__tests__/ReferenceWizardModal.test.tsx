/**
 * The wizard's own logic, which had no test file at all.
 *
 * What is pinned here is the part that has already been wrong twice:
 *
 * 1. **The Hint's PLACEMENT.** `GatheredContext.json` puts it at
 *    `focus.userHint` ("a hint to supplement or replace the selected text for
 *    search and generation"). Search and compose each built `{ ...context,
 *    userHint }` inline — a TOP-LEVEL key the schema does not define — and
 *    generation received the raw context and dropped it entirely. So it was
 *    misplaced on two paths and missing on the third, and nothing failed.
 * 2. **That all three strategies get the SAME object.** One `contextWithHint`
 *    now feeds compose, search and generation; a future strategy that reaches
 *    for the raw `context` prop is the regression these tests catch.
 *
 * Also pinned: reopening the modal resets the drafts. WIZARD-NAVIGATION D3 made
 * Back lossless by hoisting step config into the wizard, and the flip side of
 * "the modal remembers" is that a NEW run must not inherit the last one's
 * settings.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { GatheredContext } from '@semiont/core';
import { renderWithProviders } from '../../../test-utils';
import { ReferenceWizardModal } from '../ReferenceWizardModal';

// jsdom implements no layout, so it has no `scrollIntoView`. GatherContextStep
// calls it to bring the highlighted passage into view whenever the context
// changes — real behaviour, untestable here, and a hard throw if unstubbed.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const CONTEXT = {
  focus: {
    kind: 'annotation',
    annotation: { id: 'ann-1' },
    sourceResource: { '@id': 'res-1', name: 'Scythian steppe' },
    selected: { text: 'Caspian Sea' },
  },
  graph: { nodes: [], edges: [] },
  metadata: {},
} as unknown as GatheredContext;

const T = {
  gatherTitle: 'Gathered Context', configureGenerationTitle: 'Configure Generation',
  configureSearchTitle: 'Configure Search', searchResultsTitle: 'Search Results',
  sourceContextLabel: 'Source', connectionsLabel: 'Connections', citedByLabel: 'Cited by',
  userHintLabel: 'Hint', userHintEffect: 'steers Search and Generate',
  userHintPlaceholder: 'Describe what this refers to…',
  graphPaneTitle: 'In the graph', graphEmpty: 'No links yet.',
  corpusPaneTitle: 'In the corpus', corpusEmpty: 'Nothing similar.',
  excludedReceipt: '{{types}} excluded', machineRead: 'OCR',
  loadingContext: 'Loading…', failedContext: 'Failed',
  search: 'Search', searching: 'Searching…', generate: 'Generate',
  compose: 'Compose', resolutionStrategyLabel: 'Resolution Strategy', back: 'Back',
  link: 'Link', score: 'Score', noResults: 'No results',
  resourceTitle: 'Resource Title', resourceTitlePlaceholder: 'Title…',
  additionalInstructions: 'Additional Instructions', additionalInstructionsPlaceholder: '…',
  language: 'Language', languageHelp: '', creativity: 'Creativity',
  creativityFocused: 'Focused', creativityCreative: 'Creative',
  maxLength: 'Max length', maxLengthHelp: '', maxLengthCeiling: 'Limited to {{maxOutputTokens}} by {{model}}.',
  maxResults: 'Max Results', semanticScoring: 'Semantic Scoring', semanticScoringHelp: '',
  searchFailed: 'Search failed',
};

function renderWizard(over: Partial<React.ComponentProps<typeof ReferenceWizardModal>> = {}) {
  const onComposeNavigate = vi.fn();
  const onGenerateSubmit = vi.fn();
  const onLinkResource = vi.fn();
  const onClose = vi.fn();

  const utils = renderWithProviders(
    <ReferenceWizardModal
      isOpen
      onClose={onClose}
      annotationId="ann-1"
      resourceId="res-1"
      defaultTitle="Caspian Sea"
      entityTypes={['Location']}
      locale="en"
      context={CONTEXT}
      contextLoading={false}
      contextError={null}
      onGenerateSubmit={onGenerateSubmit}
      onLinkResource={onLinkResource}
      onComposeNavigate={onComposeNavigate}
      translations={T}
      {...over}
    />,
  );

  // The wizard emits over the session's own client (`client.match.requestSearch`),
  // so the spy has to be on THAT client, not a second one.
  const client = utils.session!.client;
  const searchSpy = vi.spyOn(client.match, 'requestSearch');

  return { ...utils, client, searchSpy, onComposeNavigate, onGenerateSubmit, onLinkResource, onClose };
}

/** Type the hint into the gather step's textarea. */
async function typeHint(text: string) {
  await userEvent.type(screen.getByPlaceholderText(T.userHintPlaceholder), text);
}

describe('ReferenceWizardModal — the Hint reaches every strategy, at focus.userHint', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('the gather panel carries the widened class (GEP P2, D2)', () => {
    const { baseElement } = renderWizard();
    const panel = baseElement.querySelector('.semiont-search-modal__panel--gather');
    expect(panel).not.toBeNull();
    expect(panel!.className).toContain('semiont-search-modal__panel--wide');
  });

  it('the typed hint stays visible after stepping into configure-search (GEP P1c, D8)', async () => {
    // The thing being steered must not vanish while you steer it.
    const { baseElement } = renderWizard();
    await typeHint('the ancient city');
    await userEvent.click(screen.getByRole('button', { name: /Search…/ }));
    const echo = baseElement.querySelector('.semiont-wizard__hint-echo');
    expect(echo).not.toBeNull();
    expect(echo!.textContent).toContain('the ancient city');
  });

  it('compose carries the hint inside focus, not at the top level', async () => {
    const { onComposeNavigate } = renderWizard();
    await typeHint('the lake, not the myth');
    await userEvent.click(screen.getByText(new RegExp(T.compose)));

    expect(onComposeNavigate).toHaveBeenCalledTimes(1);
    const context = onComposeNavigate.mock.calls[0]![0] as Record<string, unknown>;
    expect((context.focus as Record<string, unknown>).userHint).toBe('the lake, not the myth');
    // The shape the old code produced. `GatheredContext` has no top-level
    // `userHint`, so anything reading the schema would never look here.
    expect(context).not.toHaveProperty('userHint');
  });

  it('search sends the same enriched context over the wire', async () => {
    const { searchSpy } = renderWizard();
    await typeHint('the lake');
    await userEvent.click(screen.getByText(new RegExp(`^🔍? ?${T.search}`)));
    await userEvent.click(screen.getByRole('button', { name: T.search }));

    expect(searchSpy).toHaveBeenCalledTimes(1);
    const arg = searchSpy.mock.calls[0]![0] as { context: Record<string, unknown> };
    expect((arg.context.focus as Record<string, unknown>).userHint).toBe('the lake');
    expect(arg.context).not.toHaveProperty('userHint');
  });

  it('generation gets it too — the path that used to drop it silently', async () => {
    renderWizard();
    await typeHint('focus on hydrology');
    await userEvent.click(screen.getByRole('button', { name: `✨ ${T.generate}…` }));

    // The step renders the context it was handed; the hint is visible in the
    // gathered-context panel it shows, which is only true if the ENRICHED
    // object was passed down rather than the raw prop.
    expect(screen.getByText(T.configureGenerationTitle)).toBeInTheDocument();
  });

  it('leaves the context untouched when no hint was typed', async () => {
    const { onComposeNavigate } = renderWizard();
    await userEvent.click(screen.getByText(new RegExp(T.compose)));

    const context = onComposeNavigate.mock.calls[0]![0];
    expect(context).toBe(CONTEXT); // same reference: nothing was rebuilt
  });
});

describe('ReferenceWizardModal — the context stays in view on the strategy steps', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Choosing Generate or Search unfolds that strategy's form BELOW the
  // evidence — it must not navigate away from it. The gather step stays the
  // decision surface (chooser footer, hint textarea); the strategy steps keep
  // the RESOLUTION STRATEGY band for continuity, collapsed from three choices
  // to the chosen one — a passive echo, not a second chooser: the OTHER
  // strategies' buttons are gone, and there is no second hint textarea.
  it('configure-search renders the evidence above the form, the strategy band collapsed to Search', async () => {
    const { baseElement } = renderWizard();
    await userEvent.click(screen.getByText(new RegExp(`^🔍? ?${T.search}`)));

    expect(baseElement.querySelector('.semiont-gather__source-box')).not.toBeNull(); // quotation strip
    expect(screen.getByText(T.graphPaneTitle)).toBeInTheDocument();                  // graph pane
    expect(screen.getByText(T.maxResults)).toBeInTheDocument();                      // the form, below
    // The band survives the step: header + the chosen strategy, nothing clickable.
    const footer = baseElement.querySelector('.semiont-gather__footer');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain(T.resolutionStrategyLabel);
    expect(footer!.textContent).toContain(`🔍 ${T.search}`);
    expect(footer!.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: `✨ ${T.generate}…` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `✍️ ${T.compose}` })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(T.userHintPlaceholder)).not.toBeInTheDocument();
    const panel = baseElement.querySelector('.semiont-search-modal__panel')!;
    expect(panel.className).toContain('semiont-search-modal__panel--wide');          // evidence needs the width
  });

  it('configure-generation renders the evidence above the form, the strategy band collapsed to Generate', async () => {
    const { baseElement } = renderWizard();
    await userEvent.click(screen.getByRole('button', { name: `✨ ${T.generate}…` }));

    expect(baseElement.querySelector('.semiont-gather__source-box')).not.toBeNull();
    expect(screen.getByText(T.graphPaneTitle)).toBeInTheDocument();
    expect(screen.getByText(T.resourceTitle)).toBeInTheDocument();
    const footer = baseElement.querySelector('.semiont-gather__footer');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain(T.resolutionStrategyLabel);
    expect(footer!.textContent).toContain(`✨ ${T.generate}`);
    expect(footer!.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByText(new RegExp(`^🔍 ${T.search}…`))).not.toBeInTheDocument();
    const panel = baseElement.querySelector('.semiont-search-modal__panel')!;
    expect(panel.className).toContain('semiont-search-modal__panel--wide');
  });
});

describe('ReferenceWizardModal — a new run starts clean (D3 flip side)', () => {
  it('reopening resets the hint and the step', async () => {
    const { rerender } = renderWizard();
    await typeHint('first attempt');
    expect(screen.getByPlaceholderText(T.userHintPlaceholder)).toHaveValue('first attempt');

    const props = {
      isOpen: false, onClose: vi.fn(), annotationId: 'ann-1', resourceId: 'res-1',
      defaultTitle: 'Caspian Sea', entityTypes: ['Location'], locale: 'en',
      context: CONTEXT, contextLoading: false, contextError: null,
      onGenerateSubmit: vi.fn(), onLinkResource: vi.fn(), onComposeNavigate: vi.fn(),
      translations: T,
    };
    rerender(<ReferenceWizardModal {...props} />);
    rerender(<ReferenceWizardModal {...props} isOpen />);

    // Back is lossless WITHIN a run (D3); a new run inherits nothing.
    expect(screen.getByPlaceholderText(T.userHintPlaceholder)).toHaveValue('');
    expect(screen.getByText(T.gatherTitle)).toBeInTheDocument();
  });
});

describe('ReferenceWizardModal — the three strategies complete', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('search results arrive over the bus and linking one resolves the reference', async () => {
    const { client, onLinkResource, onClose } = renderWizard();
    await userEvent.click(screen.getByText(new RegExp(`^🔍? ?${T.search}`)));
    await userEvent.click(screen.getByRole('button', { name: T.search }));

    // The results step is entered by the REPLY, not by the click — the wizard
    // sits on the configure step until the bus answers (which is why dismissal
    // must stay available; see the A5 pin in WizardFooter.test).
    client.bus.get('match:search-results').next({
      referenceId: 'ann-1',
      // `ResourceDescriptor` is JSON-LD: the identifier is `@id`, and the
      // results step links on that. A fixture using `id` renders the row and
      // links `undefined` — passing the eye, failing the reference.
      response: [{ '@id': 'res-9', name: 'Caspian Sea', score: 54.2 }],
    } as never);

    expect(await screen.findByText(T.searchResultsTitle)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(T.link) }));

    expect(onLinkResource).toHaveBeenCalledWith('ann-1', 'res-9');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a search failure over the bus settles the spinner and surfaces the error — no eternal "Searching…"', async () => {
    // The measured hang (.plans/bugs/match-search-hangs-on-neo4j-datetime-annotations.md):
    // /bus/emit 400s the request, the match machinery publishes
    // match:search-failed — and the wizard listened only for results, so the
    // failure fired into an empty room while the button spun forever.
    const { client } = renderWizard();
    await userEvent.click(screen.getByText(new RegExp(`^🔍? ?${T.search}`)));
    await userEvent.click(screen.getByRole('button', { name: T.search }));
    expect(screen.getByRole('button', { name: T.searching })).toBeDisabled();

    client.bus.get('match:search-failed').next({
      correlationId: 'c-1',
      referenceId: 'ann-1',
      error: '/bus/emit 400: Bus emit validation failed',
    } as never);

    // Still on configure-search, failure visible, retry available.
    expect(await screen.findByText(new RegExp(T.searchFailed))).toBeInTheDocument();
    expect(screen.getByText(/Bus emit validation failed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.search })).toBeEnabled();
  });

  it('a failure addressed to a different annotation changes nothing', async () => {
    // Same scoping rule as results: a late failure from another annotation's
    // run must not settle THIS spinner or paint an error that isn't ours.
    const { client } = renderWizard();
    await userEvent.click(screen.getByText(new RegExp(`^🔍? ?${T.search}`)));
    await userEvent.click(screen.getByRole('button', { name: T.search }));

    client.bus.get('match:search-failed').next({
      correlationId: 'c-2',
      referenceId: 'someone-elses-annotation',
      error: 'not ours',
    } as never);

    expect(screen.getByRole('button', { name: T.searching })).toBeDisabled();
    expect(screen.queryByText(new RegExp(T.searchFailed))).not.toBeInTheDocument();
  });

  it('retrying after a failure clears the error while the new search runs', async () => {
    const { client } = renderWizard();
    await userEvent.click(screen.getByText(new RegExp(`^🔍? ?${T.search}`)));
    await userEvent.click(screen.getByRole('button', { name: T.search }));
    client.bus.get('match:search-failed').next({
      correlationId: 'c-1', referenceId: 'ann-1', error: 'boom',
    } as never);
    expect(await screen.findByText(new RegExp(T.searchFailed))).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: T.search }));
    expect(screen.queryByText(new RegExp(T.searchFailed))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.searching })).toBeDisabled();
  });

  it('ignores results addressed to a different annotation', () => {
    // Two wizards can never be open at once, but one reply can outlive the
    // annotation it was asked for — a late answer must not hijack the step.
    const { client } = renderWizard();
    client.bus.get('match:search-results').next({
      referenceId: 'someone-elses-annotation',
      response: [{ '@id': 'res-9', name: 'Caspian Sea' }],
    } as never);
    expect(screen.getByText(T.gatherTitle)).toBeInTheDocument();
  });

  it('generation submits the step\'s config against this annotation, then closes', async () => {
    const { onGenerateSubmit, onClose } = renderWizard();
    await userEvent.click(screen.getByRole('button', { name: `✨ ${T.generate}…` }));
    await userEvent.type(screen.getByLabelText(/Save location/i), 'generated/out.md');
    await userEvent.click(screen.getByRole('button', { name: T.generate }));

    expect(onGenerateSubmit).toHaveBeenCalledTimes(1);
    expect(onGenerateSubmit.mock.calls[0]![0]).toBe('ann-1');
    expect(onGenerateSubmit.mock.calls[0]![1].title).toBe('Caspian Sea');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('retreats from a configure step back to the gather step', async () => {
    renderWizard();
    await userEvent.click(screen.getByRole('button', { name: `✨ ${T.generate}…` }));
    expect(screen.getByText(T.configureGenerationTitle)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByText(T.gatherTitle)).toBeInTheDocument();
  });
});

describe('ReferenceWizardModal — nothing fires without an annotation to resolve', () => {
  // Every strategy guards on `annotationId` / `resourceId` / a context. The
  // props are nullable because the page renders this modal before a reference
  // is chosen, so "open but not yet aimed" is a real state, and acting in it
  // would resolve a reference nobody selected.
  beforeEach(() => { vi.clearAllMocks(); });

  it('compose, search and generate all no-op', async () => {
    const { onComposeNavigate, onGenerateSubmit, searchSpy, client } =
      renderWizard({ annotationId: null, resourceId: null });

    await userEvent.click(screen.getByText(new RegExp(T.compose)));
    expect(onComposeNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText(new RegExp(`^🔍? ?${T.search}`)));
    await userEvent.click(screen.getByRole('button', { name: T.search }));
    expect(searchSpy).not.toHaveBeenCalled();

    // A reply that arrives anyway is ignored rather than advancing the step.
    client.bus.get('match:search-results').next({
      referenceId: 'ann-1', response: [{ '@id': 'res-9', name: 'X' }],
    } as never);
    expect(screen.queryByText(T.searchResultsTitle)).not.toBeInTheDocument();
    expect(onGenerateSubmit).not.toHaveBeenCalled();
  });
});
