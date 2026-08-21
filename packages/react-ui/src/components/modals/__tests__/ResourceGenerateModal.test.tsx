/**
 * GENERATE-FROM-BUTTON P2/P4 → FLOW-LIFECYCLE-CONVERGENCE P3 →
 * GATHER-AT-THE-TOP P2 — the resource-generate flow modal.
 *
 * One composite stack, no step machine: the gather controls sit at the TOP,
 * the gathered evidence appears below them once gather fires, and the
 * generation params render beneath the evidence once context arrives —
 * [gather zone] → [evidence] → [act zone], the same grammar the resolve
 * wizard expresses. Gather state arrives as PROPS (the page reads
 * `gather.resourceContext$` and friends off the state unit) and the gather
 * itself is an `onGather` callback — the modal mocks no hook and reaches for
 * no provider (FLC A6). Entity-type options are owner-supplied, so a failed
 * load cannot surface as an empty vocabulary.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { GatheredContext } from '@semiont/core';
import type { ResourceGatherOptions } from '@semiont/sdk';
import type { GenerationConfig } from '../ConfigureGenerationStep';
import { ResourceGenerateModal } from '../ResourceGenerateModal';

const RESOURCE_CONTEXT = {
  focus: { kind: 'resource', resource: { '@id': 'res-1', name: 'My Resource' }, summary: 'A short summary' },
  graph: { nodes: [{ id: 'res-1', type: 'resource', label: 'My Resource' }], edges: [] },
  metadata: {},
} as unknown as GatheredContext;

const T = {
  configureTitle: 'Configure Generation',
  gatherIntro: 'Choose what to include.',
  includeContent: 'Include content',
  includeSummary: 'Include summary',
  gatherDepth: 'Depth',
  gatherMaxResources: 'Max resources',
  gatherButton: 'Gather',
  excludeLabel: 'Exclude from recall',
  loadingContext: 'Gathering…',
  failedContext: 'Failed',
  sourceContextLabel: 'Resource',
  connectionsLabel: 'Connections',
  citedByLabel: 'Cited by',
  graphPaneTitle: 'In the graph',
  graphEmpty: 'No links yet.',
  corpusPaneTitle: 'In the corpus',
  corpusEmpty: 'Nothing similar in the corpus.',
  excludedReceipt: '{{types}} excluded from this recall',
  machineRead: 'OCR',
  score: 'Score',
  resourceTitle: 'New resource title',
  resourceTitlePlaceholder: 'Title…',
  saveLocation: 'Save location',
  additionalInstructions: 'Additional Instructions',
  additionalInstructionsPlaceholder: 'Optional…',
  language: 'Language',
  languageHelp: 'Language help',
  creativity: 'Creativity',
  creativityFocused: 'Focused',
  creativityCreative: 'Creative',
  maxLength: 'Max Length',
  maxLengthHelp: 'Max help',
  maxLengthCeiling: 'Limited to {{maxOutputTokens}} tokens by {{model}}.',
  generate: 'Generate',
  discardDraftPrompt: 'Discard this draft?',
  discardDraft: 'Discard',
  keepEditing: 'Keep editing',
};

let onClose: Mock<() => void>;
let onGenerateSubmit: Mock<(resourceId: string, config: GenerationConfig) => void>;
let onGather: Mock<(options: ResourceGatherOptions) => void>;

function renderModal(props: Partial<React.ComponentProps<typeof ResourceGenerateModal>> = {}) {
  return render(
    <ResourceGenerateModal
      isOpen
      onClose={onClose}
      resourceId="res-1"
      defaultTitle="Default Title"
      locale="en"
      entityTypeOptions={['Person', 'Topic']}
      onGenerateSubmit={onGenerateSubmit}
      gatherContext={null}
      gatherLoading={false}
      gatherError={null}
      onGather={onGather}
      translations={T}
      {...props}
    />,
  );
}

describe('ResourceGenerateModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onClose = vi.fn<() => void>();
    onGenerateSubmit = vi.fn<(resourceId: string, config: GenerationConfig) => void>();
    onGather = vi.fn<(options: ResourceGatherOptions) => void>();
    // jsdom doesn't implement scrollIntoView; GatherContextStep may call it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders nothing when closed', () => {
    renderModal({ isOpen: false });
    expect(screen.queryByText(T.configureTitle)).not.toBeInTheDocument();
  });

  it('opens with the gather controls at the top and nothing below them yet', () => {
    // Stale slots must not leak a previous run's evidence into a fresh open:
    // even with a context PROP already present, nothing renders below the
    // controls until THIS run's gather fires.
    const { baseElement } = renderModal({ gatherContext: RESOURCE_CONTEXT });
    expect(screen.getByText(T.configureTitle)).toBeInTheDocument(); // the one modal title
    expect(screen.getByText(T.gatherIntro)).toBeInTheDocument();
    expect(screen.getByLabelText(T.includeContent)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Topic' })).toBeInTheDocument();
    expect(baseElement.querySelector('.semiont-wizard__step-scroll')).not.toBeNull();
    expect(screen.queryByText(T.graphPaneTitle)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(T.resourceTitle)).not.toBeInTheDocument();
  });

  it('Gather emits onGather and the evidence zone appears in place (exclusion omitted when none picked)', () => {
    // The modal no longer knows how to gather — it says WHAT to gather and the
    // page wires the state unit (FLC D3). No resourceId in the payload: the
    // owner already holds it.
    const { baseElement } = renderModal({ gatherLoading: true });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({ includeContent: true, includeSummary: true, depth: 2, maxResources: 10 });
    expect(baseElement.querySelector('.semiont-gather__loading')).not.toBeNull();
    // The controls stay put above the evidence — no page flip.
    expect(screen.getByText(T.gatherIntro)).toBeInTheDocument();
  });

  it('threads picked entity types into the gather options', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Person' })); // select to exclude
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({
      includeContent: true,
      includeSummary: true,
      depth: 2,
      maxResources: 10,
      excludeEntityTypes: ['Person'],
    });
  });

  it('params render beneath the evidence once context arrives; Generate emits and closes', () => {
    renderModal({ gatherContext: RESOURCE_CONTEXT }); // gather resolves immediately

    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));

    fireEvent.change(screen.getByLabelText(T.resourceTitle), { target: { value: 'Generated Doc' } });
    fireEvent.change(screen.getByLabelText(T.saveLocation), { target: { value: 'generated/out.md' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

    expect(onGenerateSubmit).toHaveBeenCalledTimes(1);
    expect(onGenerateSubmit).toHaveBeenCalledWith(
      'res-1',
      expect.objectContaining({
        title: 'Generated Doc',
        storagePath: 'file://generated/out.md',
        context: RESOURCE_CONTEXT,
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('a failed gather shows its failure in place', () => {
    // The props are the state unit's slots verbatim; the modal renders them
    // without owning them (FLC A6).
    renderModal({ gatherLoading: true });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));

    render(
      <ResourceGenerateModal
        isOpen onClose={onClose} resourceId="res-1" defaultTitle="Default Title"
        locale="en" entityTypeOptions={['Person', 'Topic']} onGenerateSubmit={onGenerateSubmit}
        gatherContext={null} gatherLoading={false} gatherError={new Error('boom')}
        onGather={onGather} translations={T}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Gather/ }).at(-1)!);
    expect(screen.getByText(T.failedContext)).toBeInTheDocument();
  });

  it('re-Gather refreshes the evidence in place — the stack stays', () => {
    renderModal({ gatherContext: RESOURCE_CONTEXT });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // tweak-and-regather
    expect(onGather).toHaveBeenCalledTimes(2);
    expect(screen.getByText(T.graphPaneTitle)).toBeInTheDocument();
    expect(screen.getByLabelText(T.resourceTitle)).toBeInTheDocument();
  });

  it('no Back anywhere — a single stack has nothing to go back to (D6)', () => {
    renderModal({ gatherContext: RESOURCE_CONTEXT });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(screen.queryAllByRole('button', { name: /Back/ })).toHaveLength(0);
  });

  it('the header close button calls onClose', () => {
    renderModal();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opening seeds the proposed title from defaultTitle, even one that arrived after mount (GFR A4)', () => {
    // The page passes the source resource's name, which loads asynchronously —
    // a draft seeded only in the useState initializer holds whatever was there
    // at FIRST render, which for the real page was ''. Opening is the moment
    // that matters: the draft re-seeds then.
    const { rerender } = render(
      <ResourceGenerateModal
        isOpen={false} onClose={onClose} resourceId="res-1" defaultTitle=""
        locale="en" entityTypeOptions={[]} onGenerateSubmit={onGenerateSubmit}
        gatherContext={RESOURCE_CONTEXT} gatherLoading={false} gatherError={null}
        onGather={onGather} translations={T}
      />,
    );
    rerender(
      <ResourceGenerateModal
        isOpen onClose={onClose} resourceId="res-1" defaultTitle="PB"
        locale="en" entityTypeOptions={[]} onGenerateSubmit={onGenerateSubmit}
        gatherContext={RESOURCE_CONTEXT} gatherLoading={false} gatherError={null}
        onGather={onGather} translations={T}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(screen.getByLabelText(T.resourceTitle)).toHaveValue('PB');
  });

  it('evidence stays in view above the params — ONE scroll pane, nothing scrolls alone (A3)', () => {
    const { baseElement } = renderModal({ gatherContext: RESOURCE_CONTEXT });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));

    const scroll = baseElement.querySelector('.semiont-wizard__step-scroll');
    expect(scroll).not.toBeNull();
    expect(scroll!.querySelector('.semiont-gather__outer')).not.toBeNull();      // the evidence
    expect(screen.getByText(T.graphPaneTitle)).toBeInTheDocument();              // graph pane up
    expect(screen.getByLabelText(T.resourceTitle)).toBeInTheDocument();          // the form, below
    for (const form of Array.from(scroll!.querySelectorAll('form.semiont-form'))) {
      expect(form.className).not.toContain('semiont-form--scrollable');
    }
  });

  it('the panel carries the widened class (GEP P2, D2)', () => {
    const { baseElement } = renderModal();
    const panel = baseElement.querySelector('.semiont-search-modal__panel--gather');
    expect(panel).not.toBeNull();
    expect(panel!.className).toContain('semiont-search-modal__panel--wide');
  });

  it('every footer is the wizard footer — no dismissal, no flex (GFR A5)', () => {
    // The modal renders via a HeadlessUI portal, so query the whole document.
    const { baseElement } = renderModal({ gatherContext: RESOURCE_CONTEXT });
    const footerPins = () => {
      expect(baseElement.querySelector('.semiont-modal__actions--wizard')).not.toBeNull();
      expect(baseElement.querySelectorAll('.semiont-button--flex')).toHaveLength(0);
      const footerButtons = Array.from(
        baseElement.querySelectorAll('.semiont-modal__actions button'),
      ).map((b) => b.textContent ?? '');
      expect(footerButtons.filter((l) => /cancel|✕/i.test(l))).toEqual([]);
    };

    footerPins(); // controls alone
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    footerPins(); // the full stack: Gather footer + Generate footer
  });
});

// GATHER-AT-THE-TOP P1: dismissal guards typed work. D5 — typed text only
// (title beyond the seeded default, save location, instructions); checkbox,
// depth, and exclusion state is cheap to redo and never nags.
describe('ResourceGenerateModal — dismissal guards typed work (GATHER-AT-THE-TOP P1)', () => {
  beforeEach(() => {
    onClose = vi.fn();
    onGenerateSubmit = vi.fn();
    onGather = vi.fn();
  });

  it('a typed save location guards dismissal; Keep editing stays, Discard closes', () => {
    renderModal({ gatherContext: RESOURCE_CONTEXT });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // reveal the stack
    fireEvent.change(screen.getByLabelText(T.saveLocation), { target: { value: 'generated/out.md' } });

    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(T.discardDraftPrompt)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: T.keepEditing }));
    expect(screen.queryByText(T.discardDraftPrompt)).not.toBeInTheDocument();
    expect(screen.getByLabelText(T.saveLocation)).toHaveValue('generated/out.md');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.click(screen.getByRole('button', { name: T.discardDraft }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a clean draft dismisses without any prompt', () => {
    renderModal({ gatherContext: RESOURCE_CONTEXT });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));

    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText(T.discardDraftPrompt)).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('non-text state alone never nags — exclusions and depth are cheap to redo (D5)', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Person' })); // pick an exclusion

    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText(T.discardDraftPrompt)).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
