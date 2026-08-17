/**
 * GENERATE-FROM-BUTTON P2/P4 — the resource-generate flow modal.
 *
 * Drives the step machine: configure-gather → review → configure-generation.
 * `useResourceGather` is mocked so we control the gathered context and assert
 * how the step wires `gather()` (incl. the Phase-4 exclusion threading) and
 * `onGenerateSubmit`. `useSemiont` is mocked to feed the entity-type options.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BehaviorSubject, of } from 'rxjs';
import type { GatheredContext } from '@semiont/core';
import type { GenerationConfig } from '../ConfigureGenerationStep';

const RESOURCE_CONTEXT = {
  focus: { kind: 'resource', resource: { id: 'res-1', name: 'My Resource' }, summary: 'A short summary' },
  graph: { nodes: [{ id: 'res-1', type: 'resource', label: 'My Resource' }], edges: [] },
  metadata: {},
} as unknown as GatheredContext;

// Mutable hook state + spies, shared with the hoisted vi.mock factory.
const h = vi.hoisted(() => ({
  gather: vi.fn(),
  reset: vi.fn(),
  state: { context: null as unknown, loading: false, error: null as Error | null },
}));

vi.mock('../../../hooks/useResourceGather', () => ({
  useResourceGather: () => ({
    context: h.state.context,
    loading: h.state.loading,
    error: h.state.error,
    gather: h.gather,
    reset: h.reset,
  }),
}));

// The modal no longer fetches entity types; the owner supplies them, so a
// failed load cannot surface as an empty vocabulary. The stable-observable
// note below is kept because the client mock still backs other calls.
// See .plans/PANEL-FAILURE-STATES.md
// Stable observable instance — the modal calls `entityTypes()` inline in
// render, so a fresh observable each call would re-subscribe every render and
// loop. The real SDK returns a cached observable; mirror that here.
const entityTypes$ = of<string[]>(['Person', 'Topic']);
const mockClient = { browse: { entityTypes: () => entityTypes$ } };
const activeSession$ = new BehaviorSubject<unknown>({ client: mockClient });
vi.mock('../../../session/SemiontProvider', async () => {
  const actual = await vi.importActual<typeof import('../../../session/SemiontProvider')>('../../../session/SemiontProvider');
  return { ...actual, useSemiont: () => ({ activeSession$ }) };
});

import { ResourceGenerateModal } from '../ResourceGenerateModal';

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
    h.state = { context: null, loading: false, error: null };
    activeSession$.next({ client: mockClient });
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

  it('submitting the gather step calls gather() and advances to review (exclusion omitted when none picked)', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(h.gather).toHaveBeenCalledWith('res-1', { includeContent: true, includeSummary: true, depth: 2, maxResources: 10 });
    expect(screen.getByText('Review Context')).toBeInTheDocument(); // step title flipped
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled(); // no context yet
  });

  it('threads picked entity types into the gather call', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Person' })); // select to exclude
    fireEvent.click(screen.getByRole('button', { name: /Gather/ }));
    expect(h.gather).toHaveBeenCalledWith('res-1', {
      includeContent: true,
      includeSummary: true,
      depth: 2,
      maxResources: 10,
      excludeEntityTypes: ['Person'],
    });
  });

  it('walks gather → review → configure-generation → emits onGenerateSubmit then closes', () => {
    h.state.context = RESOURCE_CONTEXT; // gather already resolved
    renderModal();

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

  it('Back from configure-generation returns to review', () => {
    h.state.context = RESOURCE_CONTEXT;
    renderModal();
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
    h.state.context = RESOURCE_CONTEXT;
    const { rerender } = render(
      <ResourceGenerateModal
        isOpen={false} onClose={onClose} resourceId="res-1" defaultTitle=""
        locale="en" entityTypeOptions={[]} onGenerateSubmit={onGenerateSubmit}
        translations={T}
      />,
    );
    rerender(
      <ResourceGenerateModal
        isOpen onClose={onClose} resourceId="res-1" defaultTitle="PB"
        locale="en" entityTypeOptions={[]} onGenerateSubmit={onGenerateSubmit}
        translations={T}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Gather/ })); // → review
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));   // → configure-generation
    expect(screen.getByLabelText('New resource title')).toHaveValue('PB');
  });

  it('every footer is the wizard footer — no dismissal, no flex (GFR A5)', () => {
    // The modal renders via a HeadlessUI portal, so query the whole document.
    h.state.context = RESOURCE_CONTEXT;
    const { baseElement } = renderModal();
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
