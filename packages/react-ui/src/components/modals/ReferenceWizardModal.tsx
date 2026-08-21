'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import { ComposeStep } from './ComposeStep';
import type { ComposeDraft, ComposeParams } from './ComposeStep';
import { useLineNumbers } from '../../contexts/LineNumbersContext';
import type { ScoredResult } from './SearchResultsStep';

type WizardStep =
  | { step: 'gather' }
  | { step: 'configure-search' }
  | { step: 'search-results'; results: ScoredResult[] }
  | { step: 'configure-generation' }
  | { step: 'compose' };

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
  /**
   * Create-and-link (COMPOSE-IN-MODAL): the host runs `yield.resource` then
   * `bind.body` and settles the promise; rejection keeps the modal open with
   * the compose footer re-enabled. Replaces the old navigate-to-page flow.
   */
  onComposeSubmit: (referenceId: string, params: ComposeParams) => Promise<void>;
  /** Picker vocabulary for compose when the reference fixed no entity types. */
  entityTypeOptions?: string[];
  /** Editor hover delay for the compose step's CodeMirror. */
  hoverDelayMs?: number;
  /** Translation strings */
  translations: {
    gatherTitle: string;
    configureGenerationTitle: string;
    configureSearchTitle: string;
    searchResultsTitle: string;
    sourceContextLabel: string;
    connectionsLabel: string;
    citedByLabel: string;
    graphPaneTitle: string;
    graphEmpty: string;
    corpusPaneTitle: string;
    corpusEmpty: string;
    excludedReceipt: string;
    machineRead: string;
    userHintLabel: string;
    userHintEffect: string;
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
    maxResults: string;
    semanticScoring: string;
    semanticScoringHelp: string;
    searchFailed: string;
    composeTitle: string;
    entityTypes: string;
    contentLabel: string;
    createAndLink: string;
    creatingAndLinking: string;
    discardDraftPrompt: string;
    discardDraft: string;
    keepEditing: string;
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
  onComposeSubmit,
  entityTypeOptions = [],
  hoverDelayMs = 300,
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
  const [searchError, setSearchError] = useState<string | null>(null);
  const [userHint, setUserHint] = useState('');
  const freshComposeDraft = (): ComposeDraft => ({
    name: defaultTitle, storagePath: '', content: '', entityTypes: [], language: locale,
  });
  const [composeDraft, setComposeDraft] = useState<ComposeDraft>(freshComposeDraft);
  const [showDiscardPrompt, setShowDiscardPrompt] = useState(false);
  // The editor consumes the shared display setting; the step itself stays
  // provider-free, so the wizard resolves it and passes it down.
  const { showLineNumbers } = useLineNumbers();

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
      setSearchError(null);
      setUserHint('');
      setComposeDraft(freshComposeDraft());
      setShowDiscardPrompt(false);
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

  // …and to failures, same scoping. A refused emit (/bus/emit 4xx), a matcher
  // error, and the match unit's timeout all land here — without this
  // subscription every one of them left the button on "Searching…" forever.
  useEventSubscription('match:search-failed', (event) => {
    if (!isOpen) return;
    if (annotationId && event.referenceId === annotationId) {
      setIsSearching(false);
      setSearchError(event.error);
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
    if (!context || !annotationId || !resourceId) return;
    setWizardStep({ step: 'compose' });
  }, [context, annotationId, resourceId]);

  const handleComposeSubmit = useCallback(async (params: ComposeParams) => {
    if (!annotationId) return;
    // Rejection propagates to ComposeStep (footer re-enables); the host
    // surfaces the error. Success closes UNCONDITIONALLY — the dirty guard
    // protects dismissal, not completion.
    await onComposeSubmit(annotationId, params);
    onClose();
  }, [annotationId, onComposeSubmit, onClose]);

  // D4: a modal dies on ✕/Escape/backdrop; a non-empty compose draft must not
  // die with it. Dismissal routes here; typed work raises an inline prompt.
  const composeDirty = wizardStep.step === 'compose' && (
    composeDraft.content.trim() !== '' ||
    composeDraft.storagePath.trim() !== '' ||
    composeDraft.name !== defaultTitle
  );
  const handleDismiss = useCallback(() => {
    if (composeDirty) {
      setShowDiscardPrompt(true);
      return;
    }
    onClose();
  }, [composeDirty, onClose]);

  const handleBackToGather = useCallback(() => {
    setWizardStep({ step: 'gather' });
  }, []);

  // The strategy steps stack evidence + step content in ONE scroll pane. On
  // entry, start at the BOTTOM: the step's own content (form, results) shows
  // in full, the evidence tucks up under the modal top, reachable by
  // scrolling up. jsdom has no layout (scrollHeight 0), so this is a no-op
  // in tests — the same posture as the viewer's guarded scrolls.
  const stepScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stepScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [wizardStep.step]);

  const handleSearchSubmit = useCallback((config: SearchConfig) => {
    if (!annotationId || !contextWithHint || !resourceId) return;
    setIsSearching(true);
    setSearchError(null);
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

  // The evidence display's translations — shared by the gather step and the
  // strategy steps, which keep the context in view (display-only, GFR A2)
  // above their forms rather than navigating away from it.
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

  // Determine title based on step
  const stepTitle = wizardStep.step === 'gather'
    ? t.gatherTitle
    : wizardStep.step === 'compose'
      ? t.composeTitle
    : wizardStep.step === 'configure-generation'
      ? t.configureGenerationTitle
      : wizardStep.step === 'configure-search'
        ? t.configureSearchTitle
        : t.searchResultsTitle;

  return (
    <Transition appear show={isOpen}>
      <Dialog as="div" className="semiont-search-modal" onClose={handleDismiss}>
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
              {/* Every step shows the evidence display now, so every step is
                  wide and gets the gather layout (flex column, capped height). */}
              <DialogPanel className="semiont-search-modal__panel semiont-search-modal__panel--with-border semiont-search-modal__panel--gather semiont-search-modal__panel--wide">
                <div className="semiont-search-modal__header">
                  <DialogTitle className="semiont-search-modal__title">
                    {stepTitle}
                  </DialogTitle>
                  <button
                    onClick={handleDismiss}
                    className="semiont-search-modal__close-button"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>

                {showDiscardPrompt && (
                  <div className="semiont-wizard__discard-prompt" role="alert">
                    <span className="semiont-wizard__discard-prompt-text">{t.discardDraftPrompt}</span>
                    <button
                      type="button"
                      className="semiont-button--danger"
                      onClick={() => { setShowDiscardPrompt(false); onClose(); }}
                    >
                      {t.discardDraft}
                    </button>
                    <button
                      type="button"
                      className="semiont-button--secondary"
                      onClick={() => setShowDiscardPrompt(false)}
                    >
                      {t.keepEditing}
                    </button>
                  </div>
                )}

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
                        userHintEffect: t.userHintEffect,
                        userHintPlaceholder: t.userHintPlaceholder,
                      },
                    }}
                    translations={displayTranslations}
                  />
                )}

                {wizardStep.step === 'compose' && context && (
                  <div className="semiont-wizard__step-scroll" ref={stepScrollRef}>
                  <GatherContextStep
                    context={context}
                    contextLoading={contextLoading}
                    contextError={contextError}
                    chosenStrategy={{ label: t.resolutionStrategyLabel, value: `✍️ ${t.compose}` }}
                    translations={displayTranslations}
                  />
                  <ComposeStep
                    draft={composeDraft}
                    onDraftChange={(patch) => setComposeDraft((d) => ({ ...d, ...patch }))}
                    referenceEntityTypes={entityTypes}
                    entityTypeOptions={entityTypeOptions}
                    showLineNumbers={showLineNumbers}
                    hoverDelayMs={hoverDelayMs}
                    onBack={handleBackToGather}
                    onCompose={handleComposeSubmit}
                    translations={{
                      resourceTitle: t.resourceTitle,
                      resourceTitlePlaceholder: t.resourceTitlePlaceholder,
                      saveLocation: t.saveLocation,
                      entityTypes: t.entityTypes,
                      language: t.language,
                      contentLabel: t.contentLabel,
                      back: t.back,
                      createAndLink: t.createAndLink,
                      creatingAndLinking: t.creatingAndLinking,
                    }}
                  />
                  </div>
                )}

                {wizardStep.step === 'configure-generation' && context && (
                  <div className="semiont-wizard__step-scroll" ref={stepScrollRef}>
                  <GatherContextStep
                    context={context}
                    contextLoading={contextLoading}
                    contextError={contextError}
                    chosenStrategy={{ label: t.resolutionStrategyLabel, value: `✨ ${t.generate}` }}
                    translations={displayTranslations}
                  />
                  <ConfigureGenerationStep
                    {...(generationAgent ? { generationAgent } : {})}
                    {...(userHint ? { hintEcho: { label: t.userHintLabel, value: userHint } } : {})}
                    context={contextWithHint ?? context}
                    config={generationDraft}
                    onConfigChange={setGenerationDraft}
                    onBack={handleBackToGather}
                    onGenerate={handleGenerateSubmit}
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
                      back: t.back,
                      generate: t.generate,
                    }}
                  />
                  </div>
                )}

                {wizardStep.step === 'configure-search' && (
                  <div className="semiont-wizard__step-scroll" ref={stepScrollRef}>
                  <GatherContextStep
                    context={context}
                    contextLoading={contextLoading}
                    contextError={contextError}
                    chosenStrategy={{ label: t.resolutionStrategyLabel, value: `🔍 ${t.search}` }}
                    translations={displayTranslations}
                  />
                  <ConfigureSearchStep
                    config={searchConfig}
                    {...(userHint ? { hintEcho: { label: t.userHintLabel, value: userHint } } : {})}
                    onConfigChange={setSearchConfig}
                    isSearching={isSearching}
                    searchError={searchError}
                    onBack={handleBackToGather}
                    onSearch={handleSearchSubmit}
                    translations={{
                      maxResults: t.maxResults,
                      semanticScoring: t.semanticScoring,
                      semanticScoringHelp: t.semanticScoringHelp,
                      back: t.back,
                      search: t.search,
                      searching: t.searching,
                      searchFailed: t.searchFailed,
                    }}
                  />
                  </div>
                )}

                {wizardStep.step === 'search-results' && context && (
                  <div className="semiont-wizard__step-scroll" ref={stepScrollRef}>
                  <GatherContextStep
                    context={context}
                    contextLoading={contextLoading}
                    contextError={contextError}
                    chosenStrategy={{ label: t.resolutionStrategyLabel, value: `🔍 ${t.search}` }}
                    translations={displayTranslations}
                  />
                  <SearchResultsStep
                    results={wizardStep.results}
                    onLink={handleLink}
                    onBack={handleBackToGather}
                    translations={{
                      noResults: t.noResults,
                      link: t.link,
                      back: t.back,
                      score: t.score,
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
