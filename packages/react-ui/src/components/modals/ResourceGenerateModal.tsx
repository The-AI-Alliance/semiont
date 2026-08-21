'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CollaboratorEntry, GatheredContext } from '@semiont/core';
import type { ResourceGatherOptions } from '@semiont/sdk';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { ConfigureGatherStep, type ResourceGatherConfig } from './ConfigureGatherStep';
import { GatherContextStep } from './GatherContextStep';
import { WizardFooter } from './WizardFooter';
import { ConfigureGenerationStep, type GenerationConfig, type GenerationDraft } from './ConfigureGenerationStep';

export interface ResourceGenerateModalTranslations {
  // Step titles + nav
  gatherTitle: string;
  reviewTitle: string;
  configureTitle: string;
  next: string;
  back: string;
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
  gatherDefaults?: Partial<ResourceGatherConfig>;
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

type Step = 'configure-gather' | 'review' | 'configure-generation';

/**
 * Resource-generate flow (GENERATE-FROM-BUTTON): configure gather options →
 * `gather.resource` → review the gathered `GatheredContext` → configure
 * generation → emit. Reuses the kind-aware `GatherContextStep` for the review.
 */
export function ResourceGenerateModal({
  isOpen,
  onClose,
  resourceId,
  defaultTitle,
  locale,
  gatherDefaults,
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

  const [step, setStep] = useState<Step>('configure-gather');
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
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setStep('configure-gather');
      setExcludeEntityTypes([]);
      setGenerationDraft(freshDraft());
    }
    wasOpen.current = isOpen;
    // freshDraft reads defaultTitle/locale at call time; the effect keys on the
    // OPENING, not on their drift while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleGather = useCallback((config: ResourceGatherConfig) => {
    setStep('review');
    onGather({
      ...config,
      ...(excludeEntityTypes.length ? { excludeEntityTypes } : {}),
    });
  }, [onGather, excludeEntityTypes]);

  const handleGenerate = useCallback((config: GenerationConfig) => {
    onGenerateSubmit(resourceId, config);
    onClose();
  }, [onGenerateSubmit, resourceId, onClose]);

  const stepTitle = step === 'configure-gather' ? t.gatherTitle : step === 'review' ? t.reviewTitle : t.configureTitle;

  // Configure-generation stacks evidence + form in ONE scroll pane; enter at
  // the BOTTOM so the parameters show in full, the evidence tucked up under
  // the modal top. jsdom has no layout (scrollHeight 0) — no-op in tests.
  const stepScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stepScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [step]);

  // Shared by review and configure-generation: stepping onward must not hide
  // what the generation will be grounded in — the context stays in view above
  // the form.
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
      <Dialog as="div" className="semiont-search-modal" onClose={onClose}>
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
                  <DialogTitle className="semiont-search-modal__title">{stepTitle}</DialogTitle>
                  <button onClick={onClose} className="semiont-search-modal__close-button" aria-label="Close">
                    ✕
                  </button>
                </div>

                {step === 'configure-gather' && (
                  <ConfigureGatherStep
                    defaults={gatherDefaults}
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
                )}

                {step === 'review' && (
                  <>
                    <GatherContextStep
                      context={gatherContext}
                      contextLoading={gatherLoading}
                      contextError={gatherError}
                      translations={displayTranslations}
                    />
                    <WizardFooter
                      backLabel={t.back}
                      onBack={() => setStep('configure-gather')}
                      primary={{
                        label: t.next,
                        type: 'button',
                        onClick: () => setStep('configure-generation'),
                        disabled: !gatherContext,
                      }}
                    />
                  </>
                )}

                {step === 'configure-generation' && gatherContext && (
                  <div className="semiont-wizard__step-scroll" ref={stepScrollRef}>
                  <GatherContextStep
                    context={gatherContext}
                    contextLoading={gatherLoading}
                    contextError={gatherError}
                    translations={displayTranslations}
                  />
                  <ConfigureGenerationStep
                    {...(generationAgent ? { generationAgent } : {})}
                    context={gatherContext}
                    config={generationDraft}
                    onConfigChange={setGenerationDraft}
                    onBack={() => setStep('review')}
                    onGenerate={handleGenerate}
                    translations={{
                      resourceTitle: t.resourceTitle,
                      resourceTitlePlaceholder: t.resourceTitlePlaceholder,
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
                      back: t.back,
                      generate: t.generate,
                    }}
                  />
                  </div>
                )}
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
