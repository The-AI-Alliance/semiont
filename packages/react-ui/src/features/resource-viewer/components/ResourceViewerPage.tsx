/**
 * ResourceViewerPage - Self-contained resource viewer component
 *
 * Handles all data loading, event subscriptions, and side effects internally.
 * Only requires minimal props from the framework layer (routing, modals).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useResourceViewedReport } from '../hooks/useResourceViewedReport';
import type { components, ResourceDescriptor, ResourceId, EventMap } from '@semiont/core';
import type { ConnectionState } from '@semiont/core';
import { annotationId, folderOf } from '@semiont/core';
import type { ComposeParams } from '../../../components/modals/ComposeStep';
import { getLanguage, getPrimaryRepresentation, getPrimaryMediaType, getStorageUri, capabilitiesOf, extensionForMediaType } from '@semiont/core';
import { ANNOTATORS } from '@semiont/react-ui';
import { ErrorBoundary } from '@semiont/react-ui';
import { AnnotationHistory } from '@semiont/react-ui';
import { UnifiedAnnotationsPanel } from '@semiont/react-ui';
import { ResourceInfoPanel } from '@semiont/react-ui';
import { CollaborationPanel } from '@semiont/react-ui';
import { JsonLdPanel } from '@semiont/react-ui';
import { Toolbar } from '@semiont/react-ui';
import { useResourceLoadingAnnouncements } from '@semiont/react-ui';
import { ResourceViewer } from '@semiont/react-ui';
import type { BrowseMediaRenderers, AnnotateMediaRenderers } from '@semiont/react-ui';
import { useObservable } from '@semiont/react-ui';
import { useResourceContent } from '../../../hooks/useResourceContent';
import { useMediaToken } from '../../../hooks/useMediaToken';
import { useCollaborators } from '../../../hooks/useCollaborators';
import { mediaUrl } from '../../../lib/media-url';
import { useToast } from '../../../components/Toast';
import { useOutcomeToasts } from '../../../hooks/useOutcomeToasts';
import { useGenerationArrival } from '../../../hooks/useGenerationArrival';
import { useTheme } from '../../../contexts/ThemeContext';
import { useLineNumbers } from '../../../contexts/LineNumbersContext';
import { useHoverDelay } from '../../../hooks/useHoverDelay';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import { useObservableExternalNavigation } from '../../../hooks/useObservableBrowse';
import { useToolbarPrefs } from '../../../hooks/useToolbarPrefs';
import { getSelectorType } from '../../../lib/media-shapes';
import { useResourceAnnotations } from '../../../contexts/ResourceAnnotationsContext';
import { useSemiont } from '../../../session/SemiontProvider';
import { createResourceViewerPageStateUnit } from '../state/resource-viewer-page-state-unit';
import { useSessionStateUnit } from '../../../hooks/useSessionStateUnit';
import { useShellStateUnit } from '../../../hooks/useShellStateUnit';
import { useTranslations } from '../../../contexts/TranslationContext';
import { ReferenceWizardModal } from '../../../components/modals/ReferenceWizardModal';
import { ResourceGenerateModal } from '../../../components/modals/ResourceGenerateModal';
import type { GenerationConfig } from '../../../components/modals/ConfigureGenerationStep';
import { toGenerationOptions } from '../generation-options';

type SemiontResource = ResourceDescriptor;

export interface ResourceViewerPageProps {
  /**
   * The resource to display
   */
  resource: SemiontResource;

  /**
   * Resource URI
   */
  rUri: ResourceId;

  /**
   * Current locale
   */
  locale: string;

  /**
   * Link component for routing
   */
  Link: React.ComponentType<any>;

  /**
   * Routes configuration
   */
  routes: any;

  /**
   * Component dependencies - passed from framework layer
   */
  ToolbarPanels: React.ComponentType<any>;

  /**
   * Callback to refetch document from parent
   */
  refetchDocument: () => Promise<unknown>;

  /**
   * Bus connection state for the active workspace. Six-valued state
   * machine from `actor.state$`; CollaborationPanel maps it to the
   * "Live" / "Disconnected" visual.
   */
  streamStatus: ConnectionState;

  /**
   * Name of the active knowledge base (for display in panels)
   */
  knowledgeBaseName?: string | undefined;

  /**
   * Media-renderer overrides, forwarded to `ResourceViewer`. Present at this
   * tier too so a host embedding the whole page — not just the viewer — can
   * still swap a renderer. See .plans/ANNOTATE-RENDERER-REGISTRY.md (D5)
   */
  browseRenderers?: BrowseMediaRenderers;
  annotateRenderers?: AnnotateMediaRenderers;
}

/**
 * ResourceViewerPage - Main component
 *
 * Uses hooks directly (NO containers, NO render props, NO ResourceViewerPageContent wrapper)
 *
 * @emits nav:push - Navigate to a resource or filtered view
 * @emits beckon:sparkle - Trigger sparkle animation on an annotation
 * @emits bind:update-body - Update annotation body content
 * @subscribes mark:archive - Archive the current resource
 * @subscribes mark:unarchive - Unarchive the current resource
 * @subscribes yield:clone - Clone the current resource
 * @subscribes beckon:sparkle - Trigger sparkle animation
 * @subscribes mark:added - Annotation was created (sparkle)
 * @subscribes mark:body-updated - Reference resolved via a linking-add operation (sparkle, both loci)
 * @subscribes browse:resource-open - Open a resource in the viewer (local links + the launcher's tour verbs)
 * @subscribes browse:entity-type-clicked - Navigate filtered by entity type
 *
 * Outcome-notification channels (mark:create-error, mark:delete-error,
 * bind:body-error, job:complete, job:fail, mark:assist-timeout) are
 * subscribed by useOutcomeToasts.
 */
export function ResourceViewerPage({
  resource,
  rUri,
  locale,
  Link,
  routes,
  ToolbarPanels,
  refetchDocument,
  streamStatus,
  knowledgeBaseName,
  browseRenderers,
  annotateRenderers,
}: ResourceViewerPageProps) {
  // Translations
  const tw = useTranslations('ReferenceWizard');
  const tg = useTranslations('ResourceGenerate');

  const browser = useSemiont();
  const session = useObservable(browser.activeSession$);
  const semiont = session?.client;
  const navigateExternal = useObservableExternalNavigation();

  // The KB's collaborator roster, for the Collaboration panel's software-agent
  // rows. Subscribed unconditionally at the top level (hooks ordering) even
  // though only one panel reads it; the underlying cache is a KB-wide
  // singleton, so this costs one shared subscription, not one per panel open.
  const { collaborators } = useCollaborators(semiont ?? null);

  // At most one entry serves `generation` — the KB's workers.* config yields one
  // inference config per job type — so `find` is exact, not a first-wins guess.
  const generationAgent = collaborators.find((entry) =>
    entry.servesJobTypes?.includes('generation'),
  );

  // ResourceViewer is bring-your-own-session: feed it the active session plus
  // host-owned navigation (reference follow) and panel control (app-scoped bus).
  const handleViewerOpenResource = useCallback((id: string) => {
    navigateExternal(`/know/resource/${id}`, { resourceId: id });
  }, [navigateExternal]);

  const handleViewerOpenPanel = useCallback((event: EventMap['panel:open']) => {
    browser.emit('panel:open', event);
  }, [browser]);

  // UI state hooks
  const { showError, showSuccess } = useToast();
  const { theme } = useTheme();
  const { showLineNumbers } = useLineNumbers();
  const { hoverDelayMs } = useHoverDelay();
  const { triggerSparkleAnimation, clearSparkle, sparkleAnnotationIds } = useResourceAnnotations();

  // Render mode chooses the content path: 'text' decodes inline; 'image'
  // and 'pdf' go through the media-token (binary) path. 'none'/registry-miss
  // fall to the text path harmlessly — the viewer shows metadata + download.
  const resourceMediaType = getPrimaryMediaType(resource) || 'text/plain';

  // Toolbar prefs: the POLICY layer (TOOLBAR-PREFS-AS-PROPS). The page owns the
  // Browser's global-toolbar UX — shared values, localStorage persistence — and
  // feeds the viewer its controlled props; the components hold no pref state policy.
  const toolbarPrefs = useToolbarPrefs(getSelectorType(resourceMediaType));
  const annotateMode = toolbarPrefs.annotateMode;
  const renderMode = capabilitiesOf(resourceMediaType)?.render;
  const isBinary = renderMode === 'image' || renderMode === 'pdf';

  // Text path: fetch and decode representation (disabled for binary — mediaToken path handles those)
  // Headless hook returns the error; the page (chrome tier) owns the toast.
  const { content: textContent, loading: textLoading, error: contentError } = useResourceContent(semiont ?? null, rUri, resource, !isBinary);

  useEffect(() => {
    if (contentError) showError('Failed to load resource representation');
  }, [contentError, showError]);

  // Binary path: fetch short-lived media token, construct URL
  const { token: mediaToken, loading: mediaTokenLoading } = useMediaToken(semiont ?? null, rUri);
  const binaryContent = (isBinary ? mediaUrl(semiont, rUri, mediaToken) : undefined) ?? '';

  const content = isBinary ? binaryContent : textContent;
  const contentLoading = isBinary ? mediaTokenLoading : textLoading;

  // Composite state unit — owns all flow VMs, wizard state, annotations, entity types
  const browseStateUnit = useShellStateUnit();
  // Session-typed + session-keyed (SESSION-TYPED-FACTORIES.md): no `!`, no
  // construction without a session, dispose-first rebuild on session swap.
  const stateUnit = useSessionStateUnit(
    session ?? undefined,
    (s) => createResourceViewerPageStateUnit(s, rUri, locale, browseStateUnit),
  );

  const annotations = useObservable(stateUnit?.annotations.value$) ?? [];
  const annotationsError = useObservable(stateUnit?.annotations.error$) ?? null;
  const groups = useObservable(stateUnit?.annotationGroups$);
  const allEntityTypes = useObservable(stateUnit?.entityTypes.value$) ?? [];
  const entityTypesError = useObservable(stateUnit?.entityTypes.error$) ?? null;
  // Three states, not two: a terminally failed list has no value EITHER, so
  // deriving "loading" from `undefined` leaves a dead request spinning for
  // ever. See .plans/PANEL-FAILURE-STATES.md
  const referencedBy = useObservable(stateUnit?.referencedBy.value$) ?? [];
  const referencedByLoading = useObservable(stateUnit?.referencedBy.loading$) ?? true;
  const referencedByError = useObservable(stateUnit?.referencedBy.error$) ?? null;
  const events = useObservable(stateUnit?.events.value$) ?? [];
  const eventsLoading = useObservable(stateUnit?.events.loading$) ?? true;
  const eventsError = useObservable(stateUnit?.events.error$) ?? null;
  const hoveredAnnotationId = useObservable(stateUnit?.beckon.hoveredAnnotationId$) ?? null;
  const pendingAnnotation = useObservable(stateUnit?.mark.pendingAnnotation$) ?? null;
  const assistingMotivation = useObservable(stateUnit?.mark.assistingMotivation$) ?? null;
  const progress = useObservable(stateUnit?.mark.progress$) ?? null;
  const activePanel = useObservable(stateUnit?.browse.activePanel$) ?? null;
  const scrollToAnnotationId = useObservable(stateUnit?.browse.scrollToAnnotationId$) ?? null;
  const panelInitialTab = useObservable(stateUnit?.browse.panelInitialTab$) ?? null;
  const onScrollCompleted = stateUnit?.browse.onScrollCompleted;
  const generationProgress = useObservable(stateUnit?.yield.progress$) ?? null;
  const isGenerating = useObservable(stateUnit?.yield.isGenerating$) ?? false;
  const generationOutcome = useObservable(stateUnit?.yield.outcome$) ?? null;

  // GENERATION-ARRIVAL P2: a completion witnessed on this page reveals the
  // derivation edge the worker minted — the annotations panel opens on
  // References, scrolls to the provenance reference, and its sparkle is
  // re-armed (the mark:added glow burned its window unseen). Never navigates
  // (A2); a held outcome on remount stays quiet (D6, inside the hook).
  const handleGenerationArrival = useCallback((annId: string) => {
    browser.emit('panel:open', { panel: 'annotations', scrollToAnnotationId: annId, motivation: 'linking' });
    triggerSparkleAnimation(annId);
  }, [browser, triggerSparkleAnimation]);
  useGenerationArrival(generationOutcome, annotations, handleGenerationArrival);

  const gatherContext = useObservable(stateUnit?.gather.context$) ?? null;
  const gatherLoading = useObservable(stateUnit?.gather.loading$) ?? false;
  const gatherError = useObservable(stateUnit?.gather.error$) ?? null;
  // Resource-gather slots (FLOW-LIFECYCLE-CONVERGENCE D2a: separate from the
  // annotation slots above — the two gathers can be live at once).
  const resourceGatherContext = useObservable(stateUnit?.gather.resourceContext$) ?? null;
  const resourceGatherLoading = useObservable(stateUnit?.gather.resourceLoading$) ?? false;
  const resourceGatherError = useObservable(stateUnit?.gather.resourceError$) ?? null;
  const wizardState = useObservable(stateUnit?.wizard$);
  const wizardOpen = wizardState?.open ?? false;
  const wizardAnnotationId = wizardState?.annotationId ?? null;
  const wizardResourceId = wizardState?.resourceId ?? null;
  const wizardDefaultTitle = wizardState?.defaultTitle ?? '';
  const wizardEntityTypes = wizardState?.entityTypes ?? [];
  const [generateOpen, setGenerateOpen] = useState(false);

  const handleWizardClose = useCallback(() => {
    stateUnit?.closeWizard();
  }, [stateUnit]);

  const handleWizardGenerateSubmit = useCallback((referenceId: string, config: GenerationConfig) => {
    clearSparkle(annotationId(referenceId));
    // D8: forwarded by spread in ONE place, so a knob added to the form is
    // never dropped on the way to the wire. `sourceLanguage` is the viewed
    // resource's language — a page fact the form cannot know.
    stateUnit?.yield.generate(config.context, toGenerationOptions(config, getLanguage(resource)));
  }, [stateUnit, clearSparkle, resource]);

  // Resource-generate flow (GENERATE-FROM-BUTTON): drive the SAME yield progress$
  // the annotation path uses so the full `AssistProgress` widget shows — NOT a
  // toast. Both paths are one `generate(context, options)` now: the context's
  // focus.kind (resource here, annotation above) decides the shape.
  const handleResourceGenerateSubmit = useCallback((_resourceId: string, config: GenerationConfig) => {
    stateUnit?.yield.generate(config.context, toGenerationOptions(config, getLanguage(resource)));
  }, [stateUnit, resource]);

  const handleWizardLinkResource = useCallback(async (referenceId: string, targetResourceId: string) => {
    if (!semiont) return;
    try {
      await semiont.bind.body(
        rUri,
        annotationId(referenceId),
        [{ op: 'add', item: { type: 'SpecificResource' as const, source: targetResourceId, purpose: 'linking' as const } }],
      );
      showSuccess('Reference linked successfully');
    } catch (error) {
      showError(`Failed to link reference: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [rUri, semiont, showSuccess, showError]);

  // COMPOSE-IN-MODAL P3: create-and-link, in place. The old flow stashed the
  // context in sessionStorage and navigated to the compose page; the modal
  // already holds the context, so the side-channel dies with the mode.
  // Text-only by design — uploads stay on the standalone compose page.
  const handleWizardComposeSubmit = useCallback(async (referenceId: string, params: ComposeParams) => {
    if (!semiont) throw new Error('No active session');
    try {
      const format = 'text/markdown';
      const file = new File(
        [new Blob([params.content], { type: format })],
        params.name + extensionForMediaType(format),
        { type: format },
      );
      const newResourceId = await new Promise<ResourceId>((resolve, reject) => {
        semiont.yield.resource({
          name: params.name,
          file,
          format,
          entityTypes: params.entityTypes,
          language: params.language,
          storageUri: params.storagePath,
        }).subscribe({
          next: (event) => { if (event.phase === 'finished') resolve(event.resourceId); },
          error: reject,
        });
      });
      await semiont.bind.body(
        rUri,
        annotationId(referenceId),
        [{ op: 'add', item: { type: 'SpecificResource' as const, source: newResourceId, purpose: 'linking' as const } }],
      );
      showSuccess('Reference successfully linked to the new resource');
    } catch (error) {
      showError(`Failed to compose resource: ${error instanceof Error ? error.message : String(error)}`);
      throw error; // ComposeStep re-enables its footer on rejection
    }
  }, [semiont, rUri, showSuccess, showError]);

  // Add resource to open tabs when it loads, and record it as this KB's
  // last-viewed for the /know landing route to resume from. Both are per-KB
  // state owned by the browser — a global last-viewed id sends that redirect
  // into the previously active KB's resource after a switch.
  useEffect(() => {
    if (resource && rUri) {
      const mediaType = getPrimaryMediaType(resource);
      browser.addOpenResource(rUri, resource.name, mediaType || undefined, getStorageUri(resource));
      browser.setLastViewedResource(rUri);
    }
  }, [resource, rUri, browser]);

  // Bridge: when the mark state unit produces a pending annotation, open the
  // annotations panel. The mark state unit (session-scoped) can't emit `panel:open`
  // (app-scoped) directly — the React tree is the natural seam between
  // the two buses.
  useEffect(() => {
    if (pendingAnnotation) {
      browser.emit('panel:open', { panel: 'annotations' });
    }
  }, [pendingAnnotation, browser]);

  // Domain events flow through the bus gateway (ActorStateUnit → local EventBus).
  // BrowseNamespace cache invalidation handles annotation/resource updates.
  // Resource-scoped freshness follows observation (#847): subscribing to the
  // resource's `browse.*` live queries acquires its scope (which bridges scoped
  // domain events into the local EventBus) and releases it on teardown.

  const handleResourceArchive = useCallback(async () => {
    if (!semiont) return;
    try {
      await semiont.mark.archive(rUri);
      await refetchDocument();
    } catch (err) {
      console.error('Failed to archive document:', err);
      showError('Failed to archive document');
    }
  }, [semiont, rUri, refetchDocument, showError]);

  const handleResourceUnarchive = useCallback(async () => {
    if (!semiont) return;
    try {
      await semiont.mark.unarchive(rUri);
      await refetchDocument();
    } catch (err) {
      console.error('Failed to unarchive document:', err);
      showError('Failed to unarchive document');
    }
  }, [semiont, rUri, refetchDocument, showError]);

  const handleResourceClone = useCallback(async () => {
    if (!semiont) return;
    try {
      const result = await semiont.yield.cloneToken(rUri);
      const token = result.token;
      browser.emit('nav:push', { path: `/know/compose?mode=clone&token=${token}`, reason: 'clone' });
    } catch (err) {
      console.error('Failed to generate clone token:', err);
      showError('Failed to generate clone link');
    }
  }, [semiont, rUri, showError, browser]);

  const handleAnnotationSparkle = useCallback(({ annotationId }: { annotationId: string }) => {
    triggerSparkleAnimation(annotationId);
  }, [triggerSparkleAnimation]);

  const handleAnnotationAdded = useCallback((stored: EventMap['mark:added']) => {
    triggerSparkleAnimation(stored.payload.annotation.id);
  }, [triggerSparkleAnimation]);

  // RESOLUTION-SPARKLE D2: a reference resolving — Compose, Search → Link, a
  // Generate job landing, or a remote collaborator — is a body update whose
  // operations add a linking SpecificResource. Exactly that sparkles; an unlink
  // (remove) or an entity-tag body change stays dark.
  const handleAnnotationBodyUpdated = useCallback((stored: EventMap['mark:body-updated']) => {
    const resolves = stored.payload.operations.some(
      (op) => op.op === 'add' && op.item.type === 'SpecificResource' && op.item.purpose === 'linking',
    );
    if (resolves) {
      triggerSparkleAnimation(stored.payload.annotationId);
    }
  }, [triggerSparkleAnimation]);

  const handleResourceOpen = useCallback(({ resourceId }: { resourceId: string }) => {
    if (routes.resourceDetail) {
      const path = routes.resourceDetail(resourceId);
      browser.emit('nav:push', { path, reason: 'reference-link' });
    }
  }, [routes.resourceDetail, browser]);

  const handleEntityTypeClicked = useCallback(({ entityType }: { entityType: string }) => {
    if (routes.know) {
      const path = `${routes.know}?entityType=${encodeURIComponent(entityType)}`;
      browser.emit('nav:push', { path, reason: 'entity-type-filter' });
    }
  }, [routes.know, browser]);

  // Outcome notifications (annotation CRUD failures, job success/decline/fail,
  // assist timed-out) live in useOutcomeToasts — they need only the resource id
  // and the toast surface. The registration below keeps the handlers that need
  // page-local dependencies (SDK actions, sparkles, settings, navigation).
  useOutcomeToasts(rUri);

  // Single useEventSubscriptions call per file (enforced by
  // scripts/compliance/audit-hooks-ordering.ts); hooks like useOutcomeToasts
  // own their channels in their own files.
  useEventSubscriptions({
    'mark:archive': handleResourceArchive,
    'mark:unarchive': handleResourceUnarchive,
    'yield:clone': handleResourceClone,
    'beckon:sparkle': handleAnnotationSparkle,
    'mark:added': handleAnnotationAdded,
    'mark:body-updated': handleAnnotationBodyUpdated,
    'browse:resource-open': handleResourceOpen,
    'browse:entity-type-clicked': handleEntityTypeClicked,
  });

  // Resource loading announcements
  const {
    announceResourceLoading,
    announceResourceLoaded
  } = useResourceLoadingAnnouncements();

  // Announce content loading state changes (app-level)
  useEffect(() => {
    if (contentLoading) {
      announceResourceLoading(resource.name);
    } else if (content) {
      announceResourceLoaded(resource.name);
    }
  }, [contentLoading, content, resource.name, announceResourceLoading, announceResourceLoaded]);

  // Report the arrival on the wire (browse:resource-viewed) — same
  // load-complete condition the announcement uses, so "viewed" means the
  // content is actually on screen (GUIDED-TOUR P5, D6).
  useResourceViewedReport(rUri, !contentLoading && !!content);

  // Derived state
  const documentEntityTypes = resource.entityTypes || [];

  // Get primary representation metadata
  const primaryRep = getPrimaryRepresentation(resource);
  const primaryMediaType = primaryRep?.mediaType;
  const primaryByteSize = primaryRep?.byteSize;

  // Combine resource with content
  const resourceWithContent = { ...resource, content };

  // Handlers for AnnotationHistory (legacy event-based interaction)
  const handleEventHover = useCallback((id: string | null) => {
    if (id) {
      session?.client.beckon.sparkle(annotationId(id));
    }
  }, [session]);

  // Clicking a history row reveals that annotation in the content. HistoryEvent
  // renders these rows as buttons labelled "View annotation", so this used to be
  // a focusable, screen-reader-announced control wired to a no-op.
  // `beckon:focus` is the existing "scroll to and highlight" contract rather
  // than a new prop chain — BrowseView already subscribed to it, AnnotateView
  // now does too. See .plans/ASSIST-SURFACE-WARTS.md Lane D.
  const handleEventClick = useCallback((id: string | null) => {
    if (id) {
      stateUnit?.beckon.focus(annotationId(id));
    }
  }, [stateUnit]);

  // Document rendering
  return (
    <div className={`semiont-document-viewer${activePanel ? ' semiont-document-viewer--panel-open' : ''}`}>
      {/* Main Content - Fills remaining height */}
      <div className="semiont-document-viewer__main">
        {/* Document Content - Left Side */}
        <div className="semiont-document-viewer__content">
          {/* Document Header - Only spans document content width */}
          <div className="semiont-document-viewer__header">
            <div className="semiont-document-viewer__header-inner">
              <h2 className="semiont-document-viewer__title">
                {resource.name}
              </h2>
            </div>
          </div>
          {/* Scrollable body wrapper - contains document content, header is sibling above */}
          <div className="semiont-document-viewer__scrollable-body" lang={getLanguage(resource) || undefined}>
            <ErrorBoundary
              fallback={(error, reset) => (
                <div className="semiont-document-viewer__error">
                  <h3 className="semiont-document-viewer__error-title">
                    Error loading document viewer
                  </h3>
                  <p className="semiont-document-viewer__error-message">
                    {error.message}
                  </p>
                  <button
                    onClick={reset}
                    className="semiont-document-viewer__error-button"
                  >
                    Try again
                  </button>
                </div>
              )}
            >
              {contentLoading ? (
                <div className="semiont-document-viewer__loading">
                  Loading document content...
                </div>
              ) : (
                <ResourceViewer
                  resource={resourceWithContent}
                  annotations={groups ?? { highlights: [], comments: [], assessments: [], references: [], tags: [] }}
                  session={session ?? null}
                  onOpenResource={handleViewerOpenResource}
                  onOpenPanel={handleViewerOpenPanel}
                  annotateMode={toolbarPrefs.annotateMode}
                  onAnnotateModeChange={toolbarPrefs.setAnnotateMode}
                  clickAction={toolbarPrefs.clickAction}
                  onClickActionChange={toolbarPrefs.setClickAction}
                  selectionMotivation={toolbarPrefs.selectionMotivation}
                  onSelectionMotivationChange={toolbarPrefs.setSelectionMotivation}
                  shape={toolbarPrefs.shape}
                  onShapeChange={toolbarPrefs.setShape}
                  sparkleAnnotationIds={sparkleAnnotationIds}
                  generatingReferenceId={generationProgress?.annotationId ?? null}
                  showLineNumbers={showLineNumbers}
                  hoverDelayMs={hoverDelayMs}
                  hoveredAnnotationId={hoveredAnnotationId}
                  {...(browseRenderers && { browseRenderers })}
                  {...(annotateRenderers && { annotateRenderers })}
                />
              )}
            </ErrorBoundary>
          </div>
        </div>

        {/* Sidebar */}
        <div className="semiont-document-viewer__sidebar">
          {/* Right Panel - Conditional based on active toolbar panel */}
          <ToolbarPanels
            activePanel={activePanel}
            theme={theme}
            width={
              activePanel === 'jsonld' ? 'w-[600px]' :
              activePanel === 'annotations' ? 'w-[400px]' :
              'w-64'
            }
          >
            {/* Archived Status */}
            {annotateMode && resource.archived && (
              <div className="semiont-document-viewer__archived-status">
                <div className="semiont-document-viewer__archived-text">
                  📦 Archived
                </div>
              </div>
            )}

            {/* Unified Annotations Panel */}
            {activePanel === 'annotations' && !resource.archived && (
              <UnifiedAnnotationsPanel
                session={session ?? null}
                onOpenResource={handleViewerOpenResource}
                annotations={annotations}
                annotators={ANNOTATORS}
                annotateMode={annotateMode}
                assistingMotivation={assistingMotivation}
                progress={progress}
                pendingAnnotation={pendingAnnotation}
                allEntityTypes={allEntityTypes}
                annotationsError={annotationsError}
                onRetryAnnotations={stateUnit?.annotations.retry}
                entityTypesError={entityTypesError}
                generatingReferenceId={generationProgress?.annotationId ?? null}
                sparkleAnnotationIds={sparkleAnnotationIds}
                referencedBy={referencedBy}
                referencedByLoading={referencedByLoading}
                referencedByError={referencedByError}
                onRetryReferencedBy={stateUnit?.referencedBy.retry}
                resourceId={rUri}
                locale={locale}
                sourceLanguage={getLanguage(resource)}
                scrollToAnnotationId={scrollToAnnotationId}
                hoveredAnnotationId={hoveredAnnotationId}
                onScrollCompleted={onScrollCompleted}
                initialTab={panelInitialTab?.tab}
                initialTabGeneration={panelInitialTab?.generation}
                Link={Link}
                routes={routes}
              />
            )}

            {/* History Panel */}
            {activePanel === 'history' && (
              <AnnotationHistory
                events={events}
                eventsLoading={eventsLoading}
                eventsError={eventsError}
                onRetryEvents={stateUnit?.events.retry}
                annotations={annotations}
                hoveredAnnotationId={hoveredAnnotationId}
                onEventHover={handleEventHover}
                onEventClick={handleEventClick}
                Link={Link}
                routes={routes}
              />
            )}

            {/* Document Info Panel */}
            {activePanel === 'info' && (
              <ResourceInfoPanel
                session={session ?? null}
                resourceId={rUri}
                documentEntityTypes={documentEntityTypes}
                documentLocale={getLanguage(resource)}
                primaryMediaType={primaryMediaType}
                primaryByteSize={primaryByteSize}
                storageUri={getStorageUri(resource)}
                isArchived={resource.archived ?? false}
                dateCreated={resource.dateCreated}
                dateModified={resource.dateModified}
                wasAttributedTo={resource.wasAttributedTo}
                wasDerivedFrom={resource.wasDerivedFrom}
                generator={resource.generator as components['schemas']['Agent'] | components['schemas']['Agent'][] | undefined}
                onGenerate={() => setGenerateOpen(true)}
                // The panel is generation's progress surface (GENERATE-FROM-
                // RESOURCE D7); no annotationId ⇒ a resource-gen job — the
                // annotation path's frame renders in the reference wizard.
                isGenerating={isGenerating}
                generationProgress={
                  generationProgress && !generationProgress.annotationId ? generationProgress : null
                }
                generationOutcome={generationOutcome}
                onDismissProgress={() => stateUnit?.yield.dismissProgress()}
              />
            )}

            {/* Collaboration Panel */}
            {activePanel === 'collaboration' && (
              <CollaborationPanel
                state={streamStatus}
                eventCount={0}
                knowledgeBaseName={knowledgeBaseName}
                collaborators={collaborators}
              />
            )}

            {/* JSON-LD Panel */}
            {activePanel === 'jsonld' && (
              <JsonLdPanel resourceId={rUri} />
            )}
          </ToolbarPanels>

          {/* Toolbar - Always visible on the right */}
          <Toolbar
            context="document"
            activePanel={activePanel}
            isArchived={resource.archived ?? false}
          />
        </div>
      </div>

      {/* Reference Resolution Wizard */}
      <ReferenceWizardModal
        {...(generationAgent ? { generationAgent } : {})}
        isOpen={wizardOpen}
        onClose={handleWizardClose}
        annotationId={wizardAnnotationId}
        resourceId={wizardResourceId}
        defaultTitle={wizardDefaultTitle}
        defaultFolder={folderOf(getStorageUri(resource))}
        entityTypes={wizardEntityTypes}
        resourceName={resource.name}
        locale={locale}
        context={gatherContext}
        contextLoading={gatherLoading}
        contextError={gatherError}
        onGenerateSubmit={handleWizardGenerateSubmit}
        onLinkResource={handleWizardLinkResource}
        onComposeSubmit={handleWizardComposeSubmit}
        entityTypeOptions={allEntityTypes}
        hoverDelayMs={hoverDelayMs}
        translations={{
          resolveTitle: tw('resolveTitle'),
          sourceContextLabel: tw('sourceContextLabel'),
          connectionsLabel: tw('connectionsLabel'),
          citedByLabel: tw('citedByLabel'),
          userHintLabel: tw('userHintLabel'),
          userHintEffect: tw('userHintEffect'),
          userHintPlaceholder: tw('userHintPlaceholder'),
          graphPaneTitle: tw('graphPaneTitle'),
          graphEmpty: tw('graphEmpty'),
          resourceLinkLabel: tw('resourceLinkLabel'),
          corpusPaneTitle: tw('corpusPaneTitle'),
          corpusEmpty: tw('corpusEmpty'),
          excludedReceipt: tw('excludedReceipt'),
          machineRead: tw('machineRead'),
          loadingContext: tw('loadingContext'),
          failedContext: tw('failedContext'),
          search: tw('search'),
          searching: tw('searching'),
          generate: tw('generate'),
          compose: tw('compose'),
          resolutionStrategyLabel: tw('resolutionStrategyLabel'),
          back: tw('back'),
          link: tw('link'),
          score: tw('score'),
          noResults: tw('noResults'),
          resourceTitle: tw('resourceTitle'),
          resourceTitlePlaceholder: tw('resourceTitlePlaceholder'),
          saveLocation: tw('saveLocation'),
          additionalInstructions: tw('additionalInstructions'),
          additionalInstructionsPlaceholder: tw('additionalInstructionsPlaceholder'),
          language: tw('language'),
          languageHelp: tw('languageHelp'),
          creativity: tw('creativity'),
          creativityFocused: tw('creativityFocused'),
          creativityCreative: tw('creativityCreative'),
          maxLength: tw('maxLength'),
          maxLengthHelp: tw('maxLengthHelp'),
          maxLengthCeiling: tw('maxLengthCeiling'),
          outputFormat: tw('outputFormat'),
          formatExtensionMismatch: tw('formatExtensionMismatch'),
          maxResults: tw('maxResults'),
          semanticScoring: tw('semanticScoring'),
          semanticScoringHelp: tw('semanticScoringHelp'),
          searchFailed: tw('searchFailed'),
          entityTypes: tw('entityTypes'),
          contentLabel: tw('contentLabel'),
          createAndLink: tw('createAndLink'),
          creatingAndLinking: tw('creatingAndLinking'),
          discardDraftPrompt: tw('discardDraftPrompt'),
          discardDraft: tw('discardDraft'),
          keepEditing: tw('keepEditing'),
        }}
      />

      {/* Resource-generate flow (GENERATE-FROM-BUTTON) */}
      <ResourceGenerateModal
        {...(generationAgent ? { generationAgent } : {})}
        isOpen={generateOpen}
        onClose={() => setGenerateOpen(false)}
        resourceId={rUri}
        // Seed the proposed title from the source resource's name (GFR D4/A4);
        // the field stays editable and required.
        defaultTitle={resource.name}
        defaultFolder={folderOf(getStorageUri(resource))}
        locale={locale}
        entityTypeOptions={allEntityTypes}
        onGenerateSubmit={handleResourceGenerateSubmit}
        gatherContext={resourceGatherContext}
        gatherLoading={resourceGatherLoading}
        gatherError={resourceGatherError}
        onGather={(options) => stateUnit?.gather.gatherResource(rUri, options)}
        translations={{
          title: tg('title'),
          gatherIntro: tg('gatherIntro'),
          includeContent: tg('includeContent'),
          includeSummary: tg('includeSummary'),
          gatherDepth: tg('gatherDepth'),
          gatherMaxResources: tg('gatherMaxResources'),
          gatherButton: tg('gatherButton'),
          editGather: tg('editGather'),
          recallLabel: tg('recallLabel'),
          loadingContext: tg('loadingContext'),
          failedContext: tg('failedContext'),
          sourceContextLabel: tg('sourceContextLabel'),
          connectionsLabel: tg('connectionsLabel'),
          citedByLabel: tg('citedByLabel'),
          graphPaneTitle: tg('graphPaneTitle'),
          graphEmpty: tg('graphEmpty'),
          resourceLinkLabel: tg('resourceLinkLabel'),
          corpusPaneTitle: tg('corpusPaneTitle'),
          corpusEmpty: tg('corpusEmpty'),
          excludedReceipt: tg('excludedReceipt'),
          machineRead: tg('machineRead'),
          score: tg('score'),
          resourceTitle: tg('resourceTitle'),
          resourceTitlePlaceholder: tg('resourceTitlePlaceholder'),
          saveLocation: tg('saveLocation'),
          additionalInstructions: tg('additionalInstructions'),
          additionalInstructionsPlaceholder: tg('additionalInstructionsPlaceholder'),
          language: tg('language'),
          languageHelp: tg('languageHelp'),
          creativity: tg('creativity'),
          creativityFocused: tg('creativityFocused'),
          creativityCreative: tg('creativityCreative'),
          maxLength: tg('maxLength'),
          maxLengthHelp: tg('maxLengthHelp'),
          maxLengthCeiling: tg('maxLengthCeiling'),
          outputFormat: tg('outputFormat'),
          formatExtensionMismatch: tg('formatExtensionMismatch'),
          generate: tg('generate'),
          discardDraftPrompt: tg('discardDraftPrompt'),
          discardDraft: tg('discardDraft'),
          keepEditing: tg('keepEditing'),
        }}
      />
    </div>
  );
}
