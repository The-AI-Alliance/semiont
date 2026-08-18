'use client';

import { useState, useEffect, useCallback } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import type { GatheredContext, CollaboratorEntry } from '@semiont/core';
import { uuidV4 } from '@semiont/core';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';
import { useEventSubscription } from '../../contexts/useEventSubscription';
import { GatherContextStep } from './GatherContextStep';
import { ConfigureGenerationStep } from './ConfigureGenerationStep';
import type { GenerationConfig } from './ConfigureGenerationStep';
import { ConfigureSearchStep } from './ConfigureSearchStep';
import type { SearchConfig } from './ConfigureSearchStep';
import type { GenerationDraft } from './ConfigureGenerationStep';
import { SearchResultsStep } from './SearchResultsStep';
import type { ScoredResult } from './SearchResultsStep';

type WizardStep =
  | { step: 'gather' }
  | { step: 'configure-search' }
  | { step: 'search-results'; results: ScoredResult[] }
  | { step: 'configure-generation' };

export interface ReferenceWizardModalProps {
  /**
   * Roster entry serving `generation`, forwarded to ConfigureGenerationStep so
   * the max-length control is bounded by the model's real output ceiling.
   * Optional: absent means today's default bounds (INFERENCE-LIMITS-EXPOSURE D3).
   */
  generationAgent?: CollaboratorEntry;
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
    maxLengthCeiling: string;
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
  onGenerateSubmit,
  onLinkResource,
  onComposeNavigate,
  translations: t,
  generationAgent,
}: ReferenceWizardModalProps) {
  const session = useObservable(useSemiont().activeSession$);
  const [wizardStep, setWizardStep] = useState<WizardStep>({ step: 'gather' });
  // Both step drafts live HERE, not in the steps (WIZARD-NAVIGATION D3). Stepping
  // back unmounts a step; if the step owned its values, Back would silently discard
  // everything typed — which is exactly what it used to do.
  const [searchConfig, setSearchConfig] = useState<SearchConfig>({ limit: 10, useSemanticScoring: true });
  const [generationDraft, setGenerationDraft] = useState<GenerationDraft>({
    title: defaultTitle, storagePath: '', prompt: '', language: locale,
    temperature: 0.7, maxTokensText: '500',
  });
  const [isSearching, setIsSearching] = useState(false);
  const [userHint, setUserHint] = useState('');

  // Reset to gather step when modal opens
  useEffect(() => {
    if (isOpen) {
      setWizardStep({ step: 'gather' });
      setSearchConfig({ limit: 10, useSemanticScoring: true });
      setGenerationDraft({
        title: defaultTitle, storagePath: '', prompt: '', language: locale,
        temperature: 0.7, maxTokensText: '500',
      });
      setIsSearching(false);
      setUserHint('');
    }
  }, [isOpen]);

  // Subscribe to search results (only react while open and for the current annotation)
  useEventSubscription('match:search-results', (event) => {
    if (!isOpen) return;
    if (annotationId && event.referenceId === annotationId) {
      setIsSearching(false);
      setWizardStep({ step: 'search-results', results: event.response as ScoredResult[] });
    }
  });

  const handleBind = useCallback(() => {
    setWizardStep({ step: 'configure-search' });
  }, []);

  /**
   * The gather step's Hint, placed where the schema says it lives.
   *
   * Two defects, one line. (1) Search and compose each built this inline and
   * generation did not, so picking the AI path silently discarded what the user had
   * typed — and then showed them an empty "Additional Instructions" box.
   * (2) Both existing sites wrote `{ ...context, userHint }`, a TOP-LEVEL key
   * `GatheredContext` does not define; `GatheredContext.json` puts it at
   * `focus.userHint` ("hint to supplement or replace the selected text for search and
   * generation"). So the hint was misplaced on every path, not just missing on one.
   *
   * Both consumers read it: the matcher folds it into its search term and its
   * LLM-scoring passage (matcher.ts, since #911), and generation's prompt builder
   * renders it in the annotation section (resource-generation.ts).
   */
  const contextWithHint = !context
    ? null
    : userHint
      ? { ...context, focus: { ...context.focus, userHint } }
      : context;

  const handleGenerate = useCallback(() => {
    setWizardStep({ step: 'configure-generation' });
  }, []);

  const handleCompose = useCallback(() => {
    if (!contextWithHint || !annotationId || !resourceId) return;
    onComposeNavigate(contextWithHint, annotationId, resourceId, defaultTitle, entityTypes);
    onClose();
  }, [contextWithHint, annotationId, resourceId, defaultTitle, entityTypes, onComposeNavigate, onClose]);

  const handleBackToGather = useCallback(() => {
    setWizardStep({ step: 'gather' });
  }, []);

  const handleSearchSubmit = useCallback((config: SearchConfig) => {
    if (!annotationId || !contextWithHint || !resourceId) return;
    setIsSearching(true);
    session?.client.match.requestSearch({
      correlationId: uuidV4(),
      resourceId,
      referenceId: annotationId,
      context: contextWithHint,
      limit: config.limit,
      useSemanticScoring: config.useSemanticScoring,
    });
    // Stay on configure-search until results arrive (subscription above handles transition)
  }, [annotationId, resourceId, contextWithHint, session]);

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
                    annotate={{
                      userHint,
                      onUserHintChange: setUserHint,
                      onBind: handleBind,
                      onGenerate: handleGenerate,
                      onCompose: handleCompose,
                      translations: {
                        search: t.search,
                        generate: t.generate,
                        compose: t.compose,
                        resolutionStrategyLabel: t.resolutionStrategyLabel,
                        userHintLabel: t.userHintLabel,
                        userHintPlaceholder: t.userHintPlaceholder,
                      },
                    }}
                    translations={{
                      loadingContext: t.loadingContext,
                      failedContext: t.failedContext,
                      sourceContextLabel: t.sourceContextLabel,
                      connectionsLabel: t.connectionsLabel,
                      citedByLabel: t.citedByLabel,
                    }}
                  />
                )}

                {wizardStep.step === 'configure-generation' && context && (
                  <ConfigureGenerationStep
                    {...(generationAgent ? { generationAgent } : {})}
                    context={contextWithHint ?? context}
                    config={generationDraft}
                    onConfigChange={setGenerationDraft}
                    onBack={handleBackToGather}
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
                      maxLengthCeiling: t.maxLengthCeiling,
                      back: t.back,
                      generate: t.generate,
                    }}
                  />
                )}

                {wizardStep.step === 'configure-search' && (
                  <ConfigureSearchStep
                    config={searchConfig}
                    onConfigChange={setSearchConfig}
                    isSearching={isSearching}
                    onBack={handleBackToGather}
                    onSearch={handleSearchSubmit}
                    translations={{
                      maxResults: t.maxResults,
                      semanticScoring: t.semanticScoring,
                      semanticScoringHelp: t.semanticScoringHelp,
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
                    translations={{
                      noResults: t.noResults,
                      link: t.link,
                      back: t.back,
                      score: t.score,
                      sourceContextLabel: t.sourceContextLabel,
                      connectionsLabel: t.connectionsLabel,
                      citedByLabel: t.citedByLabel,
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
