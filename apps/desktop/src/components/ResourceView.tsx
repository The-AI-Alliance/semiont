import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  getSupportedShapes,
  mediaUrl,
  ResourceTagsInline,
  ResourceViewer,
  useMediaToken,
  useObservable,
  useResourceContent,
  useResourceLoader,
  useTranslationManager,
  type AnnotationsCollection,
  type ShapeType,
} from '@semiont/react-ui';
import {
  capabilitiesOf,
  getPrimaryMediaType,
  getResourceEntityTypes,
  type AnchorRect,
  type Annotation,
  type ResourceDescriptor,
} from '@semiont/core';
import { resourceId as brandResourceId, type ResourceId } from '@semiont/sdk';
import { findAnnotation } from '../lib/annotation-detail';
import { QUESTION_ENTITY_TYPE, type ChatSession } from '../lib/session';
import { AnnotationDetailCard } from './AnnotationDetailCard';
import { PendingCreationPopover, useAnnotationCreation } from './AnnotationCreator';
import { DelegationControl } from './DelegationControl';
import { ShapeControl } from './ShapeControl';
import type { ViewerPrefs } from './ViewerPrefControls';

const MIN_RESOURCE_ZOOM = 0.5;
const MAX_RESOURCE_ZOOM = 3;
const RESOURCE_ZOOM_STEP = 0.1;

function clampResourceZoom(zoom: number): number {
  return Math.max(MIN_RESOURCE_ZOOM, Math.min(MAX_RESOURCE_ZOOM, zoom));
}

/**
 * The main pane's in-app document view — native, over `@semiont/react-ui`'s bring-your-own-session
 * `ResourceViewer`. It loads the resource + annotations from OUR `SemiontSession` (no
 * `SemiontProvider` or cache; react-ui's copy comes from `AppProviders`' translation provider),
 * renders content + the annotation overlay for
 * any media type, and routes reference clicks back to the host's nav via `onOpenResource`. This
 * replaced an earlier Electron `<webview>` stopgap.
 *
 * The header, tags strip, and status states render against a possibly-still-loading descriptor;
 * the viewer itself mounts via `LoadedDocument` once the descriptor settles (react-ui's headless
 * `useResourceContent` takes a settled `ResourceDescriptor`).
 */
export function ResourceView({
  session,
  prefs,
  resourceId,
  name,
  onClose,
  onOpenResource,
}: {
  session: ChatSession;
  /** App-global click action + motivation (controlled props on the viewer). */
  prefs: ViewerPrefs;
  resourceId: string;
  name: string;
  onClose: () => void;
  /** A reference clicked inside the viewer — open that resource (host-owned nav). */
  onOpenResource: (id: string) => void;
}) {
  const rid = useMemo(() => brandResourceId(resourceId), [resourceId]);
  const { resource, annotations, loading, error } = useResourceLoader(session.client, rid);

  const mediaType = resource ? getPrimaryMediaType(resource) || 'text/plain' : 'text/plain';

  // The resource's own entity-type classification, shown as chrome around the viewer (not in it).
  const entityTags = getResourceEntityTypes(resource);

  // Per-document annotate mode — the pencil in the header (controlled prop on the viewer).
  const [annotate, setAnnotate] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomStyle = {
    zoom,
    '--resource-zoom-inverse': String(1 / zoom),
  } as CSSProperties;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const bodyRef = useRef<HTMLDivElement>(null);

  // Chromium reports macOS trackpad pinch as a ctrl+wheel event. Handle it only
  // while the pointer is over this resource pane, preserving ordinary scrolling
  // everywhere else in the app. A non-passive listener lets us stop page zoom.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? body.clientHeight
          : 1;
      const next = clampResourceZoom(zoomRef.current * Math.exp(-event.deltaY * deltaScale * 0.002));
      zoomRef.current = next;
      setZoom(next);
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, []);

  // A rejected tag update (the server's vocabulary gate, PR #974) — surfaced inline. The
  // strip's own commit has no catch: rejecting would recover silently + leak an unhandled
  // rejection, so the handler below swallows and reports here instead.
  const [tagError, setTagError] = useState<string | null>(null);

  // Per-document annotation shape (controlled prop; the header ShapeControl edits it).
  const [shape, setShape] = useState<ShapeType>(() => getSupportedShapes(mediaType)[0] ?? 'rectangle');

  // Annotate-mode creation (same as MessageView): react-ui's seam claims this pane's viewer
  // selections by `source`; chat's wrapper dispatches.
  const { pending, clearPending } = useAnnotationCreation(session, rid, annotate);

  // Find-references delegation params: the KB's entity types (Question excluded, as
  // everywhere). No per-document provenance store here — the form starts undimmed.
  const kbEntityTypesState = useObservable(useMemo(() => session.client.browse.entityTypes(), [session]));
  const kbEntityTypes = kbEntityTypesState?.status === 'ready' ? kbEntityTypesState.value : [];
  const markableEntityTypes = kbEntityTypes.filter((t) => t !== QUESTION_ENTITY_TYPE);

  return (
    <section className="rview">
      <header className="rview__bar">
        {/* The caller may only know the id (e.g. a reference click hands us just that) — prefer
            the loaded descriptor's name once it arrives. */}
        <span className="rview__name" title={resource?.name ?? name}>
          {resource?.name ?? name}
        </span>
        <div className="rview__zoom-controls" role="group" aria-label="Resource zoom">
          <button
            type="button"
            onClick={() => setZoom((current) => clampResourceZoom(current - RESOURCE_ZOOM_STEP))}
            disabled={zoom <= MIN_RESOURCE_ZOOM}
            aria-label="Zoom out"
            title="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="rview__zoom-level"
            onClick={() => setZoom(1)}
            disabled={zoom === 1}
            aria-label={`Reset resource zoom, currently ${Math.round(zoom * 100)} percent`}
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((current) => clampResourceZoom(current + RESOURCE_ZOOM_STEP))}
            disabled={zoom >= MAX_RESOURCE_ZOOM}
            aria-label="Zoom in"
            title="Zoom in"
          >
            +
          </button>
        </div>
        {annotate && markableEntityTypes.length > 0 && (
          <DelegationControl
            className="rview__delegctl"
            session={session}
            resourceId={rid}
            entityTypes={markableEntityTypes}
            delegated={[]}
            motivation={prefs.motivation}
          />
        )}
        {annotate && (
          <ShapeControl className="prefctl--down rview__shapectl" mediaType={mediaType} shape={shape} onShapeChange={setShape} />
        )}
        <button
          type="button"
          className={`rview__pencil${annotate ? ' rview__pencil--on' : ''}`}
          onClick={() => {
            setAnnotate((v) => !v);
            setTagError(null);
          }}
          aria-pressed={annotate}
          aria-label={annotate ? 'Stop annotating this document' : 'Annotate this document'}
          title={annotate ? 'Stop annotating this document' : 'Annotate this document'}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>
        <button type="button" className="rview__close" onClick={onClose} aria-label="Close document" title="Close">
          ×
        </button>
      </header>
      {/* react-ui's tags strip: editable in annotate mode (the pencil), updates through the
          SDK (`mark.updateEntityTypes`), then a descriptor poke repaints. `vocabulary` is the
          KB's registered types (Question excluded, as everywhere) — entity tags are a
          controlled vocabulary, so the add picker offers only these. */}
      <ResourceTagsInline
        resourceId={String(rid)}
        tags={entityTags}
        isEditing={annotate}
        vocabulary={markableEntityTypes}
        onUpdate={async (updated) => {
          setTagError(null);
          try {
            await session.client.mark.updateEntityTypes(rid, entityTags, updated);
            await session.client.browse.resource(rid).fresh();
          } catch (err) {
            setTagError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      {annotate && tagError !== null && (
        <p className="rview__tagerr" role="alert">
          {tagError}
        </p>
      )}
      <div className="rview__body" ref={bodyRef}>
        <div className="rview__zoom-canvas" style={zoomStyle}>
          {error !== null ? (
            <p className="rview__status" role="alert">
              {error.message}
            </p>
          ) : loading || resource === undefined ? (
            <p className="rview__status">Loading…</p>
          ) : (
            <LoadedDocument
              session={session}
              rid={rid}
              resource={resource}
              annotations={annotations}
              prefs={prefs}
              annotate={annotate}
              onAnnotateModeChange={setAnnotate}
              shape={shape}
              onShapeChange={setShape}
              onOpenResource={onOpenResource}
            />
          )}
        </div>
      </div>
      {pending !== null && (
        <PendingCreationPopover session={session} resourceId={rid} pending={pending} onClose={clearPending} />
      )}
    </section>
  );
}

/** The full-size viewer for a settled descriptor: content via react-ui's headless
 *  `useResourceContent` (text) or a short-lived media-token URL (image/PDF). Content-load
 *  errors are deliberately unused — the viewer falls back to metadata + download. */
function LoadedDocument({
  session,
  rid,
  resource,
  annotations,
  prefs,
  annotate,
  onAnnotateModeChange,
  shape,
  onShapeChange,
  onOpenResource,
}: {
  session: ChatSession;
  rid: ResourceId;
  resource: ResourceDescriptor;
  annotations: AnnotationsCollection;
  prefs: ViewerPrefs;
  annotate: boolean;
  onAnnotateModeChange: (on: boolean) => void;
  shape: ShapeType;
  onShapeChange: (shape: ShapeType) => void;
  onOpenResource: (id: string) => void;
}) {
  const translationManager = useTranslationManager();
  const mediaType = getPrimaryMediaType(resource) || 'text/plain';
  const renderMode = capabilitiesOf(mediaType)?.render;
  const isBinary = renderMode === 'image' || renderMode === 'pdf';

  const { content: textContent, error: contentError } = useResourceContent(
    !isBinary ? session.client : null,
    rid,
    resource,
    !isBinary,
  );
  const { token } = useMediaToken(isBinary ? session.client : null, rid);
  const content = isBinary
    ? mediaUrl(session.client, rid, token) ?? ''
    : textContent;

  // Detail click action → the pinned annotation card, anchored to the annotation's own
  // rect (the AnchorRect riding `browse:click` → `onOpenPanel` from every emitter).
  const [detail, setDetail] = useState<{ annotation: Annotation; anchorRect: AnchorRect } | null>(null);

  // A text document's content is undefined until it has loaded (an empty one loads as '').
  if (content === undefined) {
    return contentError !== null ? (
      <p className="rview__status" role="alert">
        {contentError.message}
      </p>
    ) : (
      <p className="rview__status">Loading…</p>
    );
  }

  return (
    <>
      <ResourceViewer
        session={session}
        translationManager={translationManager}
        showToolbar={false}
        resource={{ ...resource, content }}
        annotations={annotations}
        annotateMode={annotate}
        onAnnotateModeChange={onAnnotateModeChange}
        clickAction={prefs.clickAction}
        onClickActionChange={prefs.onClickActionChange}
        selectionMotivation={prefs.motivation}
        onSelectionMotivationChange={prefs.onMotivationChange}
        shape={shape}
        onShapeChange={onShapeChange}
        onOpenResource={onOpenResource}
        onOpenPanel={({ scrollToAnnotationId, anchorRect }) => {
          // No rect → no card (rectless re-emissions, e.g. a click on the card's own
          // entry, must not move an open card).
          if (scrollToAnnotationId === undefined || anchorRect === undefined) return;
          const annotation = findAnnotation(annotations, scrollToAnnotationId);
          if (annotation !== null) setDetail({ annotation, anchorRect });
        }}
      />
      {detail !== null && (
        <AnnotationDetailCard
          session={session}
          annotation={detail.annotation}
          anchorRect={detail.anchorRect}
          annotateMode={annotate}
          onOpenResource={onOpenResource}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}
