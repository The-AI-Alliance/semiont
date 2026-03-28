'use client';

import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import type { GatheredContext, EventBus } from '@semiont/core';
import { GatherContextStep } from './GatherContextStep';
import { ConfigureGenerationStep } from './ConfigureGenerationStep';
import type { GenerationConfig } from './ConfigureGenerationStep';
import { ConfigureSearchStep } from './ConfigureSearchStep';
import type { SearchConfig } from './ConfigureSearchStep';
import { SearchResultsStep } from './SearchResultsStep';
import type { ScoredResult } from './SearchResultsStep';

type WizardStep =
  | { step: 'gather' }
  | { step: 'configure-search' }
  | { step: 'search-results'; results: ScoredResult[] }
  | { step: 'configure-generation' };

export interface ReferenceWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The annotation being resolved */
  annotationId: string | null;
  /** The resource containing the annotation */
  resourceId: string | null;
  /** Default title (selected text) */
  defaultTitle: string;
  /** Entity types from the annotation */
  entityTypes: string[];
  /** Current locale for generation defaults */
  locale: string;
  /** Gathered context state */
  context: GatheredContext | null;
  contextLoading: boolean;
  contextError: Error | null;
  /** Event bus for emitting downstream events */
  eventBus: EventBus;
  /** Callbacks */
  onGenerateSubmit: (referenceId: string, config: GenerationConfig) => void;
  onLinkResource: (referenceId: string, targetResourceId: string) => void;
  onComposeNavigate: (context: GatheredContext, annotationId: string, resourceId: string, title: string, entityTypes: string[]) => void;
  /** Translation strings */
  translations: {
    gatherTitle: string;
    configureGenerationTitle: string;
    configureSearchTitle: string;
    searchResultsTitle: string;
    sourceContextLabel: string;
    connectionsLabel: string;
    citedByLabel: string;
    userHintLabel: string;
    userHintPlaceholder: string;
    loadingContext: string;
    failedContext: string;
    cancel: string;
    search: string;
    searching: string;
    generate: string;
    compose: string;
    resolutionStrategyLabel: string;
    back: string;
    link: string;
    score: string;
    noResults: string;
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
    maxResults: string;
    semanticScoring: string;
    semanticScoringHelp: string;
  };
}

export function ReferenceWizardModal({
  isOpen,
  onClose,
  annotationId,
  resourceId,
  defaultTitle,
  entityTypes,
  locale,
  context,
  contextLoading,
  contextError,
  eventBus,
  onGenerateSubmit,
  onLinkResource,
  onComposeNavigate,
  translations: t,
}: ReferenceWizardModalProps) {
  const [wizardStep, setWizardStep] = useState<WizardStep>({ step: 'gather' });
  const [isSearching, setIsSearching] = useState(false);
  const [userHint, setUserHint] = useState('');

  // Reset to gather step when modal opens
  useEffect(() => {
    if (isOpen) {
      setWizardStep({ step: 'gather' });
      setIsSearching(false);
      setUserHint('');
    }
  }, [isOpen]);

  // Subscribe to search results
  useEffect(() => {
    if (!isOpen) return;

    const subscription = eventBus.get('match:search-results').subscribe((event) => {
      const e = event as { referenceId: string; results: ScoredResult[] };
      if (annotationId && e.referenceId === annotationId) {
        setIsSearching(false);
        setWizardStep({ step: 'search-results', results: e.results });
      }
    });

    return () => subscription.unsubscribe();
  }, [isOpen, eventBus, annotationId]);

  const handleBind = useCallback(() => {
    setWizardStep({ step: 'configure-search' });
  }, []);

  const handleGenerate = useCallback(() => {
    setWizardStep({ step: 'configure-generation' });
  }, []);

  const handleCompose = useCallback(() => {
    if (!context || !annotationId || !resourceId) return;
    const contextWithHint = userHint ? { ...context, userHint } : context;
    onComposeNavigate(contextWithHint, annotationId, resourceId, defaultTitle, entityTypes);
    onClose();
  }, [context, annotationId, resourceId, defaultTitle, entityTypes, onComposeNavigate, onClose, userHint]);

  const handleBackToGather = useCallback(() => {
    setWizardStep({ step: 'gather' });
  }, []);

  const handleSearchSubmit = useCallback((config: SearchConfig) => {
    if (!annotationId || !context) return;
    setIsSearching(true);
    const contextWithHint = userHint ? { ...context, userHint } : context;
    eventBus.get('match:search-requested').next({
      referenceId: annotationId,
      context: contextWithHint,
      limit: config.limit,
      useSemanticScoring: config.useSemanticScoring,
    });
    // Stay on configure-search until results arrive (subscription above handles transition)
  }, [annotationId, context, eventBus, userHint]);

  const handleGenerateSubmit = useCallback((config: GenerationConfig) => {
    if (!annotationId) return;
    onGenerateSubmit(annotationId, config);
    onClose();
  }, [annotationId, onGenerateSubmit, onClose]);

  const handleLink = useCallback((targetResourceId: string) => {
    if (!annotationId) return;
    onLinkResource(annotationId, targetResourceId);
    onClose();
  }, [annotationId, onLinkResource, onClose]);

  // Determine title based on step
  const stepTitle = wizardStep.step === 'gather'
    ? t.gatherTitle
    : wizardStep.step === 'configure-generation'
      ? t.configureGenerationTitle
      : wizardStep.step === 'configure-search'
        ? t.configureSearchTitle
        : t.searchResultsTitle;

  return (
    <Transition appear show={isOpen}>
      <Dialog as="div" className="semiont-search-modal" onClose={onClose}>
        {/* Backdrop */}
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

        {/* Modal panel */}
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
              <DialogPanel className={`semiont-search-modal__panel semiont-search-modal__panel--with-border${wizardStep.step === 'search-results' ? ' semiont-search-modal__panel--wide' : ''}${wizardStep.step === 'gather' ? ' semiont-search-modal__panel--gather' : ''}`}>
                <div className="semiont-search-modal__header">
                  <DialogTitle className="semiont-search-modal__title">
                    {stepTitle}
                  </DialogTitle>
                  <button
                    onClick={onClose}
                    className="semiont-search-modal__close-button"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                {wizardStep.step === 'gather' && (
                  <GatherContextStep
                    context={context}
                    contextLoading={contextLoading}
                    contextError={contextError}
                    userHint={userHint}
                    onUserHintChange={setUserHint}
                    onBind={handleBind}
                    onGenerate={handleGenerate}
                    onCompose={handleCompose}
                    translations={{
                      title: t.gatherTitle,
                      sourceContextLabel: t.sourceContextLabel,
                      connectionsLabel: t.connectionsLabel,
                      citedByLabel: t.citedByLabel,
                      userHintLabel: t.userHintLabel,
                      userHintPlaceholder: t.userHintPlaceholder,
                      loadingContext: t.loadingContext,
                      failedContext: t.failedContext,
                      search: t.search,
                      generate: t.generate,
                      compose: t.compose,
                      resolutionStrategyLabel: t.resolutionStrategyLabel,
                    }}
                  />
                )}

                {wizardStep.step === 'configure-generation' && context && (
                  <ConfigureGenerationStep
                    defaultTitle={defaultTitle}
                    locale={locale}
                    context={context}
                    onBack={handleBackToGather}
                    onCancel={onClose}
                    onGenerate={handleGenerateSubmit}
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

                {wizardStep.step === 'configure-search' && (
                  <ConfigureSearchStep
                    isSearching={isSearching}
                    onBack={handleBackToGather}
                    onCancel={onClose}
                    onSearch={handleSearchSubmit}
                    translations={{
                      maxResults: t.maxResults,
                      semanticScoring: t.semanticScoring,
                      semanticScoringHelp: t.semanticScoringHelp,
                      cancel: t.cancel,
                      back: t.back,
                      search: t.search,
                      searching: t.searching,
                    }}
                  />
                )}

                {wizardStep.step === 'search-results' && context && (
                  <SearchResultsStep
                    results={wizardStep.results}
                    context={context}
                    onLink={handleLink}
                    onBack={handleBackToGather}
                    onCancel={onClose}
                    translations={{
                      noResults: t.noResults,
                      link: t.link,
                      back: t.back,
                      cancel: t.cancel,
                      score: t.score,
                      sourceContextLabel: t.sourceContextLabel,
                      connectionsLabel: t.connectionsLabel,
                      citedByLabel: t.citedByLabel,
                      userHintLabel: t.userHintLabel,
                      userHintPlaceholder: t.userHintPlaceholder,
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
