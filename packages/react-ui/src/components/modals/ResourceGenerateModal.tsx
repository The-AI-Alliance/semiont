'use client';

import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useResourceGather } from '../../hooks/useResourceGather';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';
import { ConfigureGatherStep, type ResourceGatherConfig } from './ConfigureGatherStep';
import { GatherContextStep } from './GatherContextStep';
import { ConfigureGenerationStep, type GenerationConfig } from './ConfigureGenerationStep';

export interface ResourceGenerateModalTranslations {
  // Step titles + nav
  gatherTitle: string;
  reviewTitle: string;
  configureTitle: string;
  next: string;
  back: string;
  cancel: string;
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
  generate: string;
}

export interface ResourceGenerateModalProps {
  isOpen: boolean;
  onClose: () => void;
  resourceId: string;
  defaultTitle: string;
  locale: string;
  gatherDefaults?: Partial<ResourceGatherConfig>;
  /**
   * Emit the chosen generation config. The parent runs the job
   * (`client.yield.fromResource(resourceId, …).run(…)`) — mirrors how the
   * annotation wizard delegates `yield.fromAnnotation` to its parent.
   */
  onGenerateSubmit: (resourceId: string, config: GenerationConfig) => void;
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
  onGenerateSubmit,
  translations: t,
}: ResourceGenerateModalProps) {
  const [step, setStep] = useState<Step>('configure-gather');
  const { context, loading, error, gather, reset } = useResourceGather();
  const client = useObservable(useSemiont().activeSession$)?.client;
  const entityTypeOptions = useObservable(client?.browse.entityTypes()) ?? [];
  const [excludeEntityTypes, setExcludeEntityTypes] = useState<string[]>([]);

  // Reset to the first step whenever the modal (re)opens.
  useEffect(() => {
    if (isOpen) {
      setStep('configure-gather');
      setExcludeEntityTypes([]);
      reset();
    }
  }, [isOpen, reset]);

  const handleGather = useCallback((config: ResourceGatherConfig) => {
    setStep('review');
    void gather(resourceId, {
      ...config,
      ...(excludeEntityTypes.length ? { excludeEntityTypes } : {}),
    });
  }, [gather, resourceId, excludeEntityTypes]);

  const handleGenerate = useCallback((config: GenerationConfig) => {
    onGenerateSubmit(resourceId, config);
    onClose();
  }, [onGenerateSubmit, resourceId, onClose]);

  const stepTitle = step === 'configure-gather' ? t.gatherTitle : step === 'review' ? t.reviewTitle : t.configureTitle;

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
              <DialogPanel className="semiont-search-modal__panel semiont-search-modal__panel--with-border semiont-search-modal__panel--gather">
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
                    onCancel={onClose}
                    translations={{
                      intro: t.gatherIntro,
                      includeContent: t.includeContent,
                      includeSummary: t.includeSummary,
                      depth: t.gatherDepth,
                      maxResources: t.gatherMaxResources,
                      cancel: t.cancel,
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
                      context={context}
                      contextLoading={loading}
                      contextError={error}
                      translations={{
                        title: '',
                        loadingContext: t.loadingContext,
                        failedContext: t.failedContext,
                        search: '',
                        generate: '',
                        compose: '',
                        resolutionStrategyLabel: '',
                        sourceContextLabel: t.sourceContextLabel,
                        connectionsLabel: t.connectionsLabel,
                        citedByLabel: t.citedByLabel,
                        userHintLabel: '',
                        userHintPlaceholder: '',
                      }}
                    />
                    <div className="semiont-modal__actions" style={{ paddingTop: '0.5rem' }}>
                      <button
                        type="button"
                        onClick={() => setStep('configure-gather')}
                        className="semiont-button--secondary semiont-button--flex"
                      >
                        ◀ {t.back}
                      </button>
                      <button
                        type="button"
                        onClick={() => setStep('configure-generation')}
                        disabled={!context}
                        className="semiont-button--primary semiont-button--flex"
                      >
                        {t.next} ▶
                      </button>
                    </div>
                  </>
                )}

                {step === 'configure-generation' && context && (
                  <ConfigureGenerationStep
                    defaultTitle={defaultTitle}
                    locale={locale}
                    context={context}
                    onBack={() => setStep('review')}
                    onCancel={onClose}
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
                      cancel: t.cancel,
                      back: t.back,
                      generate: t.generate,
                    }}
                  />
                )}
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
