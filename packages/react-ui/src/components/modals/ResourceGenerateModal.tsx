'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CollaboratorEntry, GatheredContext } from '@semiont/core';
import type { ResourceGatherOptions } from '@semiont/sdk';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { ConfigureGatherStep, type ResourceGatherConfig } from './ConfigureGatherStep';
import { DiscardPrompt } from './DiscardPrompt';
import { GatherContextStep } from './GatherContextStep';
import { ConfigureGenerationStep, type GenerationConfig, type GenerationDraft } from './ConfigureGenerationStep';

export interface ResourceGenerateModalTranslations {
  // The one modal title (GATHER-AT-THE-TOP D7)
  configureTitle: string;
  // ConfigureGatherStep
  gatherIntro: string;
  includeContent: string;
  includeSummary: string;
  gatherDepth: string;
  gatherMaxResources: string;
  gatherButton: string;
  excludeLabel: string;
  // GatherContextStep display
  loadingContext: string;
  failedContext: string;
  sourceContextLabel: string;
  connectionsLabel: string;
  citedByLabel: string;
  graphPaneTitle: string;
  graphEmpty: string;
  corpusPaneTitle: string;
  corpusEmpty: string;
  excludedReceipt: string;
  machineRead: string;
  score: string;
  // ConfigureGenerationStep
  resourceTitle: string;
  resourceTitlePlaceholder: string;
  saveLocation: string;
  additionalInstructions: string;
  additionalInstructionsPlaceholder: string;
  language: string;
  languageHelp: string;
  creativity: string;
  creativityFocused: string;
  creativityCreative: string;
  maxLength: string;
  maxLengthHelp: string;
  maxLengthCeiling: string;
  generate: string;
  // DiscardPrompt (GATHER-AT-THE-TOP P1)
  discardDraftPrompt: string;
  discardDraft: string;
  keepEditing: string;
}

export interface ResourceGenerateModalProps {
  /**
   * Roster entry serving `generation`, forwarded to ConfigureGenerationStep so
   * the max-length control is bounded by the model's real output ceiling.
   * Optional: absent means today's default bounds (INFERENCE-LIMITS-EXPOSURE D3).
   */
  generationAgent?: CollaboratorEntry;
  isOpen: boolean;
  onClose: () => void;
  resourceId: string;
  defaultTitle: string;
  locale: string;
  /**
   * Entity types offered in the exclusion picker. Owner-supplied so the
   * modal cannot present a failed load as an empty vocabulary.
   */
  entityTypeOptions?: string[];
  /**
   * Emit the chosen generation config. The parent runs the job
   * (`client.yield.fromContext(config.context, …)`) — mirrors how the
   * annotation wizard delegates generation to its parent.
   */
  onGenerateSubmit: (resourceId: string, config: GenerationConfig) => void;
  /**
   * Resource-gather state, verbatim from the SDK's gather unit slots
   * (`gather.resourceContext$` / `resourceLoading$` / `resourceError$`) — the
   * page reads the observables and threads them here, the same shape the
   * reference wizard has always had (FLOW-LIFECYCLE-CONVERGENCE D3/A6). The
   * modal renders this state; it never owns it.
   */
  gatherContext: GatheredContext | null;
  gatherLoading: boolean;
  gatherError: Error | null;
  /**
   * Run the gather — the page wires `gather.gatherResource(resourceId, …)`.
   * No resourceId in the payload: the owner already holds it. `gatherResource`
   * clears its slots at start, so no reset threading is needed.
   */
  onGather: (options: ResourceGatherOptions) => void;
  translations: ResourceGenerateModalTranslations;
}

/**
 * Resource-generate flow (GENERATE-FROM-BUTTON, folded by GATHER-AT-THE-TOP):
 * one composite stack in a single scroll pane — the gather controls at the
 * top, the gathered `GatheredContext` below them once gather fires, and the
 * generation params beneath the evidence once context arrives. Re-gathering
 * is scroll-up → tweak → Gather; `gatherResource` clears its slots at start,
 * so the evidence refreshes in place. [gather zone] → [evidence] → [act
 * zone]: the same grammar the resolve wizard expresses, whose gather zone
 * happens to be automatic and whose act zone has a strategy choice.
 */
export function ResourceGenerateModal({
  isOpen,
  onClose,
  resourceId,
  defaultTitle,
  locale,
  entityTypeOptions = [],
  onGenerateSubmit,
  gatherContext,
  gatherLoading,
  gatherError,
  onGather,
  translations: t,
  generationAgent,
}: ResourceGenerateModalProps) {
  // Same draft ownership as the wizard (WIZARD-NAVIGATION D3): the step is
  // controlled, so stepping back through this modal keeps what was typed.
  const freshDraft = (): GenerationDraft => ({
    title: defaultTitle, storagePath: '', prompt: '', language: locale,
    temperature: 0.7, maxTokensText: '500',
  });
  const [generationDraft, setGenerationDraft] = useState<GenerationDraft>(freshDraft);

  // "Has THIS run gathered yet?" — the page's gather slots survive across
  // opens, so a context prop can be stale at open time. Nothing renders below
  // the controls until the user fires a gather in this run.
  const [gatherFired, setGatherFired] = useState(false);
  const [showDiscardPrompt, setShowDiscardPrompt] = useState(false);
  // Supplied by the owner, which already tracks the list with its failure
  // state. Fetching it here could only model (value | not-yet), so a failed
  // load would render an empty exclusion picker as though the KB had no
  // entity types. See .plans/PANEL-FAILURE-STATES.md
  const [excludeEntityTypes, setExcludeEntityTypes] = useState<string[]>([]);

  // Reset to the first step ON OPENING — and re-seed the draft, because
  // `defaultTitle` is the source resource's name and loads asynchronously: the
  // useState initializer ran at mount, which for the real page was before the
  // name existed (GFR A4). Guarded to the false→true transition so a name
  // arriving mid-flow cannot clobber what the user has typed.
  const wasOpen = useRef(false);
  // The dirty baseline is what was SEEDED, not the live prop: defaultTitle
  // can move while the modal is open (the source resource's name loads
  // asynchronously), and an untouched draft must not read as dirty because
  // the baseline moved under it.
  const seededTitle = useRef(defaultTitle);
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setGatherFired(false);
      setExcludeEntityTypes([]);
      setGenerationDraft(freshDraft());
      setShowDiscardPrompt(false);
      seededTitle.current = defaultTitle;
    }
    wasOpen.current = isOpen;
    // freshDraft reads defaultTitle/locale at call time; the effect keys on the
    // OPENING, not on their drift while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleGather = useCallback((config: ResourceGatherConfig) => {
    setGatherFired(true);
    onGather({
      ...config,
      ...(excludeEntityTypes.length ? { excludeEntityTypes } : {}),
    });
  }, [onGather, excludeEntityTypes]);

  const handleGenerate = useCallback((config: GenerationConfig) => {
    onGenerateSubmit(resourceId, config);
    onClose();
  }, [onGenerateSubmit, resourceId, onClose]);

  // D4/D5 (GATHER-AT-THE-TOP P1): typed text must not die with a dismissed
  // modal. Toggles, depth, and exclusion picks are cheap to redo and never
  // nag. Generate's completion path above bypasses this — the guard protects
  // dismissal, not completion.
  const draftDirty =
    generationDraft.title !== seededTitle.current ||
    generationDraft.storagePath.trim() !== '' ||
    generationDraft.prompt.trim() !== '';
  const handleDismiss = useCallback(() => {
    if (draftDirty) {
      setShowDiscardPrompt(true);
      return;
    }
    onClose();
  }, [draftDirty, onClose]);

  // The whole stack is ONE scroll pane; when the params zone appears (context
  // arrival — including each re-gather), enter at the BOTTOM so the
  // parameters show in full, the evidence and controls tucked up under the
  // modal top. jsdom has no layout (scrollHeight 0) — no-op in tests.
  const stepScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stepScrollRef.current;
    if (el && gatherContext) el.scrollTop = el.scrollHeight;
  }, [gatherContext]);

  // The evidence zone: what the generation will be grounded in stays in view
  // above the form.
  const displayTranslations = {
    loadingContext: t.loadingContext,
    failedContext: t.failedContext,
    sourceContextLabel: t.sourceContextLabel,
    connectionsLabel: t.connectionsLabel,
    citedByLabel: t.citedByLabel,
    graphPaneTitle: t.graphPaneTitle,
    graphEmpty: t.graphEmpty,
    corpusPaneTitle: t.corpusPaneTitle,
    corpusEmpty: t.corpusEmpty,
    excludedReceipt: t.excludedReceipt,
    machineRead: t.machineRead,
    score: t.score,
  };

  return (
    <Transition appear show={isOpen}>
      <Dialog as="div" className="semiont-search-modal" onClose={handleDismiss}>
        <TransitionChild
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="semiont-search-modal__backdrop" />
        </TransitionChild>

        <div className="semiont-search-modal__wrapper">
          <div className="semiont-search-modal__centering semiont-search-modal__centering--center">
            <TransitionChild
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="semiont-search-modal__panel semiont-search-modal__panel--with-border semiont-search-modal__panel--gather semiont-search-modal__panel--wide">
                <div className="semiont-search-modal__header">
                  <DialogTitle className="semiont-search-modal__title">{t.configureTitle}</DialogTitle>
                  <button onClick={handleDismiss} className="semiont-search-modal__close-button" aria-label="Close">
                    ✕
                  </button>
                </div>

                {showDiscardPrompt && (
                  <DiscardPrompt
                    prompt={t.discardDraftPrompt}
                    discardLabel={t.discardDraft}
                    keepLabel={t.keepEditing}
                    onDiscard={() => { setShowDiscardPrompt(false); onClose(); }}
                    onKeepEditing={() => setShowDiscardPrompt(false)}
                  />
                )}

                <div className="semiont-wizard__step-scroll" ref={stepScrollRef}>
                  <ConfigureGatherStep
                    onGather={handleGather}
                    translations={{
                      intro: t.gatherIntro,
                      includeContent: t.includeContent,
                      includeSummary: t.includeSummary,
                      depth: t.gatherDepth,
                      maxResources: t.gatherMaxResources,
                      gather: t.gatherButton,
                    }}
                  >
                    {entityTypeOptions.length > 0 && (
                      <div className="semiont-form__field semiont-form__entity-types">
                        <label className="semiont-form__label">{t.excludeLabel}</label>
                        <div className="semiont-form__entity-type-buttons">
                          {entityTypeOptions.map((et) => {
                            const isSelected = excludeEntityTypes.includes(et);
                            return (
                              <button
                                key={et}
                                type="button"
                                className="semiont-form__entity-type-button"
                                data-selected={isSelected}
                                aria-pressed={isSelected}
                                onClick={() => setExcludeEntityTypes(prev => prev.includes(et) ? prev.filter(x => x !== et) : [...prev, et])}
                              >
                                {et}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </ConfigureGatherStep>

                  {gatherFired && (
                    <GatherContextStep
                      context={gatherContext}
                      contextLoading={gatherLoading}
                      contextError={gatherError}
                      translations={displayTranslations}
                    />
                  )}

                  {gatherFired && gatherContext && (
                    <ConfigureGenerationStep
                      {...(generationAgent ? { generationAgent } : {})}
                      context={gatherContext}
                      config={generationDraft}
                      onConfigChange={setGenerationDraft}
                      onGenerate={handleGenerate}
                      translations={{
                        resourceTitle: t.resourceTitle,
                        resourceTitlePlaceholder: t.resourceTitlePlaceholder,
                        saveLocation: t.saveLocation,
                        additionalInstructions: t.additionalInstructions,
                        additionalInstructionsPlaceholder: t.additionalInstructionsPlaceholder,
                        language: t.language,
                        languageHelp: t.languageHelp,
                        creativity: t.creativity,
                        creativityFocused: t.creativityFocused,
                        creativityCreative: t.creativityCreative,
                        maxLength: t.maxLength,
                        maxLengthHelp: t.maxLengthHelp,
                        maxLengthCeiling: t.maxLengthCeiling,
                        generate: t.generate,
                      }}
                    />
                  )}
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
