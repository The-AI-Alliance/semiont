/**
 * GENERATE-FROM-BUTTON P2/P4 → FLOW-LIFECYCLE-CONVERGENCE P3 — the
 * resource-generate flow modal.
 *
 * Drives the step machine: configure-gather → review → configure-generation.
 * Gather state arrives as PROPS (the page reads `gather.resourceContext$` and
 * friends off the state unit) and the gather itself is an `onGather` callback —
 * the modal mocks no hook and reaches for no provider (FLC A6). Entity-type
 * options are owner-supplied, so a failed load cannot surface as an empty
 * vocabulary (see .plans/PANEL-FAILURE-STATES.md).
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
  gatherTitle: 'Configure Gather',
  reviewTitle: 'Review Context',
  configureTitle: 'Configure Generation',
  next: 'Next',
  back: 'Back',
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
    expect(screen.queryByText('Configure Gather')).not.toBeInTheDocument();
  });

  it('opens on the configure-gather step with the exclusion options', () => {
    renderModal();
    expect(screen.getByText('Configure Gather')).toBeInTheDocument(); // step title
    expect(screen.getByText('Choose what to include.')).toBeInTheDocument();
    expect(screen.getByLabelText('Include content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Topic' })).toBeInTheDocument();
  });

  it('submitting the gather step emits onGather and advances to review (exclusion omitted when none picked)', () => {
    // The modal no longer knows how to gather — it says WHAT to gather and the
    // page wires the state unit (FLC D3). No resourceId in the payload: the
    // owner already holds it.
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(onGather).toHaveBeenCalledWith({ includeContent: true, includeSummary: true, depth: 2, maxResources: 10 });
    expect(screen.getByText('Review Context')).toBeInTheDocument(); // step title flipped
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled(); // no context yet
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

  it('walks gather → review → configure-generation → emits onGenerateSubmit then closes', () => {
    renderModal({ gatherContext: RESOURCE_CONTEXT }); // gather already resolved

    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // → review
    const next = screen.getByRole('button', { name: /Next/ });
    expect(next).toBeEnabled();
    fireEvent.click(next); // → configure-generation

    fireEvent.change(screen.getByLabelText('New resource title'), { target: { value: 'Generated Doc' } });
    fireEvent.change(screen.getByLabelText('Save location'), { target: { value: 'generated/out.md' } });
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

  it('a loading gather shows its progress, an error shows its failure', () => {
    // The props are the state unit's slots verbatim; the modal renders them
    // without owning them (FLC A6).
    const { rerender, baseElement } = renderModal({ gatherLoading: true });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // → review
    expect(baseElement.querySelector('.semiont-gather__loading')).not.toBeNull();

    rerender(
      <ResourceGenerateModal
        isOpen onClose={onClose} resourceId="res-1" defaultTitle="Default Title"
        locale="en" entityTypeOptions={['Person', 'Topic']} onGenerateSubmit={onGenerateSubmit}
        gatherContext={null} gatherLoading={false} gatherError={new Error('boom')}
        onGather={onGather} translations={T}
      />,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('Back from configure-generation returns to review', () => {
    renderModal({ gatherContext: RESOURCE_CONTEXT });
    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // → review
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));   // → configure-generation
    expect(screen.getByText('Configure Generation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));   // → review
    expect(screen.getByText('Review Context')).toBeInTheDocument();
  });

  it('Back from review returns to the configure-gather step', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // → review
    expect(screen.getByText('Review Context')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Back/ })); // → configure-gather
    expect(screen.getByText('Configure Gather')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // → review
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));   // → configure-generation
    expect(screen.getByLabelText('New resource title')).toHaveValue('PB');
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

    footerPins(); // configure-gather
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    footerPins(); // review
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    footerPins(); // configure-generation (already WizardFooter — stays that way)
  });
});
