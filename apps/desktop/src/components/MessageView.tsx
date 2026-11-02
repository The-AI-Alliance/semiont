import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  getSupportedShapes,
  ResourceViewer,
  useMediaToken,
  useResourceContent,
  useResourceLoader,
  useTranslationManager,
  type AnnotationsCollection,
  type ReferenceHover,
  type ShapeType,
} from '@semiont/react-ui';
import {
  capabilitiesOf,
  getPrimaryMediaType,
  reconcile,
  type AnchorRect,
  type Annotation,
  type ResourceDescriptor,
} from '@semiont/core';
import { resourceId as brandResourceId, type ResourceId } from '@semiont/sdk';
import { findAnnotation } from '../lib/annotation-detail';
import { attestationOf } from '../lib/attestation';
import { createResolvedReference } from '../lib/chat-turn';
import type { ChatSession } from '../lib/session';
import { AnnotationDetailCard } from './AnnotationDetailCard';
import { PendingCreationPopover, useAnnotationCreation } from './AnnotationCreator';
import { DelegationControl } from './DelegationControl';
import { LinkSelectionPopover } from './LinkSelectionPopover';
import { AnchoredHovercard } from './ResourceHovercard';
import { ShapeControl } from './ShapeControl';
import type { ViewerPrefs } from './ViewerPrefControls';

const CARD_WIDTH = 320;

interface MessageProps {
  session: ChatSession;
  resourceId: string;
  /** The message text when we already hold it (question / answer markdown) — no refetch.
   *  Omit for uploads: text is fetched, image/pdf go through a media-token URL. */
  content?: string;
  /** App-global click action + motivation (controlled props on the viewer). */
  prefs: ViewerPrefs;
  /** The KB's delegable entity types (Question excluded) — params for `find-references`. */
  markableEntityTypes: string[];
  /** Types already delegated on this resource (per-turn provenance) — dimmed in the form. */
  delegatedEntityTypes?: string[];
  /** A `find-references` delegation completed — the host records the types. */
  onDelegated?: (entityTypes: string[]) => void;
  /** A reference clicked in the message — open the referent in the main pane. */
  onOpenResource: (id: string, name: string) => void;
}

/**
 * A chat message rendered as what it is — a resource — via react-ui's embeddable viewer
 * (#944 `inline` variant: auto-height, no inner scroll, no pane chrome). This outer shell
 * only loads the descriptor; everything content-shaped lives in `LoadedMessage`, which
 * mounts once the descriptor exists (react-ui's content/creation hooks take a SETTLED
 * `ResourceDescriptor` — the split is the no-lies way to compose them with the loader).
 * While the descriptor loads, any text we already hold paints immediately
 * (render-before-enrich, as ever).
 */
export const MessageView = memo(function MessageView(props: MessageProps) {
  const rid = useMemo(() => brandResourceId(props.resourceId), [props.resourceId]);
  const { resource, annotations, error } = useResourceLoader(props.session.client, rid);

  if (resource === undefined) {
    // Descriptor still loading — paint any text we hold now; the viewer takes over in a
    // beat. If the load ERRORED (typically: a chat from history whose resources live in a
    // different KB than the one now behind this URI), the text is all there will ever be —
    // dim the bubble so the missing annotation layer is legible, not mysterious.
    const stale = error !== null;
    return (
      <div className="msg">
        <div
          className={`msg__card msg--plain${stale ? ' msg--stale' : ''}`}
          {...(stale ? { title: 'This message’s resource isn’t available in the connected knowledge base.' } : {})}
        >
          {props.content ?? ''}
        </div>
      </div>
    );
  }

  return <LoadedMessage {...props} rid={rid} resource={resource} annotations={annotations} />;
});

/**
 * The message with its descriptor settled. The viewer overlays the resource's annotations
 * and emits every interaction to us:
 *  - reference click → `onOpenResource` (host nav, same as everywhere else);
 *  - reference hover → `onReferenceHover({annotation, referent, anchorRect})` → our chat-styled
 *    `ResourceHovercard` (+ provenance attestation), positioned off the span's rect;
 *  - content link click → `onLinkClick` → externals to the OS browser (Electron main's
 *    window-open handler routes them via shell.openExternal), everything else ignored;
 *  - annotate-mode selections/draws → `mark:requested`, claimed by `useAnnotationCreation`.
 *
 * Content: the text we already hold on the turn when present (no refetch); otherwise
 * react-ui's headless `useResourceContent` (uploaded text docs), or a media-token URL for
 * binary media.
 */
function LoadedMessage({
  session,
  resourceId,
  content,
  prefs,
  markableEntityTypes,
  delegatedEntityTypes,
  onDelegated,
  onOpenResource,
  rid,
  resource,
  annotations,
}: MessageProps & {
  rid: ResourceId;
  resource: ResourceDescriptor;
  annotations: AnnotationsCollection;
}) {
  // Per-message annotate mode (the pencil): controlled prop on the viewer, so unlocking THIS
  // message never touches any other (TOOLBAR-PREFS-AS-PROPS semantics).
  const [annotate, setAnnotate] = useState(false);
  const translationManager = useTranslationManager();

  const mediaType = getPrimaryMediaType(resource) || 'text/plain';
  const renderMode = capabilitiesOf(mediaType)?.render;
  const isBinary = renderMode === 'image' || renderMode === 'pdf';

  // Per-message annotation shape (controlled prop, like the pencil). The default follows the
  // medium's supported set — a future medium without 'rectangle' still starts on a valid shape.
  const [shape, setShape] = useState<ShapeType>(() => getSupportedShapes(mediaType)[0] ?? 'rectangle');

  // Text path without locally-held content (an uploaded text doc): react-ui's headless
  // content hook. Its content is undefined until it has loaded (an empty one loads as '').
  const wantFetch = !isBinary && content === undefined;
  const { content: fetchedContent, error: contentError } = useResourceContent(
    wantFetch ? session.client : null,
    rid,
    resource,
    wantFetch,
  );

  // Binary path: short-lived authed media-token URL (same as the main-pane ResourceView).
  const { token } = useMediaToken(isBinary ? session.client : null, rid);
  const resolvedContent = isBinary
    ? token
      ? `${session.client.baseUrl}/api/resources/${rid}?token=${token}`
      : ''
    : (content ?? fetchedContent);

  // Reference hover → our hovercard, anchored to the span's rect.
  const [hover, setHover] = useState<ReferenceHover | null>(null);

  // Detail click action → the clicked annotation's record, pinned at the annotation's own
  // rect (the AnchorRect riding `browse:click` → `onOpenPanel` from every emitter).
  const [detail, setDetail] = useState<{ annotation: Annotation; anchorRect: AnchorRect } | null>(null);

  // Post-send selection-linking (D2 path b): select text in this message → a floating "Link"
  // affordance → the target chooser → ONE pre-resolved reference annotation on this resource.
  const containerRef = useRef<HTMLDivElement>(null);

  // Annotate-mode creation: react-ui's seam claims this viewer's `mark:requested`; chat's
  // wrapper dispatches (immediate motivations create, others open the popover).
  const { pending, clearPending } = useAnnotationCreation(session, rid, annotate);
  const [linkSel, setLinkSel] = useState<{ exact: string; rect: DOMRect } | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Document-level listener: the viewer's internals stop mouseup propagation, and a selection
  // drag can end outside the bubble — so watch globally and claim only selections whose range
  // lives inside THIS message. Live state is read through a ref (a queued callback with a stale
  // closure must never dismiss an open chooser).
  const chooserOpenRef = useRef(false);
  chooserOpenRef.current = chooserOpen;
  useEffect(() => {
    if (isBinary) return undefined;
    const onUp = (event: MouseEvent) => {
      // let the browser finalize the selection first
      setTimeout(() => {
        if (chooserOpenRef.current) return; // never dismiss under the open chooser
        const container = containerRef.current;
        const sel = window.getSelection();
        const exact = sel?.toString() ?? '';
        if (!sel || sel.isCollapsed || exact.trim().length < 3 || sel.rangeCount === 0 || container === null) {
          // keep the CTA if the mouseup was ON it (clicking it collapses the selection)
          if (!(event.target instanceof Element) || event.target.closest('.linksel__cta') === null) setLinkSel(null);
          return;
        }
        const range = sel.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) return; // another message's selection
        setLinkError(null);
        setLinkSel({ exact, rect: range.getBoundingClientRect() });
      }, 0);
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [isBinary]);

  const linkTo = async (target: { id: string; name: string }) => {
    if (linkSel === null || resolvedContent === undefined) return;
    const source = resolvedContent; // text messages: the source text the selectors anchor on
    const anchored = reconcile(source, { exact: linkSel.exact });
    if (anchored === null) {
      setLinkError('Couldn’t anchor that selection in the source text.');
      return;
    }
    try {
      await createResolvedReference(
        session,
        rid,
        source,
        { start: anchored.start, end: anchored.end },
        brandResourceId(target.id),
      );
      // `.fresh()` does a one-shot backend fetch and updates the cache the loader
      // subscribes to — the new reference paints without a remount (same pattern as
      // the mark chips' post-run refetch).
      await session.client.browse.annotations(rid).fresh();
      setChooserOpen(false);
      setLinkSel(null);
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    }
  };

  const popStyle: CSSProperties | null = useMemo(() => {
    if (linkSel === null) return null;
    const r = linkSel.rect;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - CARD_WIDTH - 8);
    return { position: 'fixed', left, top: r.bottom + 6, width: CARD_WIDTH, zIndex: 60 };
  }, [linkSel]);

  if (resolvedContent === undefined) {
    return (
      <div className="msg" ref={containerRef}>
        <div className="msg__card">
          {contentError !== null ? (
            <p className="rview__status" role="alert">
              {contentError.message}
            </p>
          ) : (
            <p className="rview__status">Loading…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="msg" ref={containerRef}>
      <div className="msg__card">
        <ResourceViewer
          session={session}
          translationManager={translationManager}
          inline
          showToolbar={false}
          resource={{ ...resource, content: resolvedContent }}
          annotations={annotations}
          annotateMode={annotate}
          onAnnotateModeChange={setAnnotate}
          clickAction={prefs.clickAction}
          onClickActionChange={prefs.onClickActionChange}
          selectionMotivation={prefs.motivation}
          onSelectionMotivationChange={prefs.onMotivationChange}
          shape={shape}
          onShapeChange={setShape}
          onOpenResource={(id) => onOpenResource(id, id)}
          onOpenPanel={({ scrollToAnnotationId, anchorRect }) => {
            // Detail click: the viewer asks the host for its annotations surface — ours is
            // the pinned card, not a side panel. No rect → no card (rectless re-emissions,
            // e.g. a click on the card's own entry, must not move an open card).
            if (scrollToAnnotationId === undefined || anchorRect === undefined) return;
            const annotation = findAnnotation(annotations, scrollToAnnotationId);
            if (annotation !== null) setDetail({ annotation, anchorRect });
          }}
          onLinkClick={({ href }) => {
            // Electron main's setWindowOpenHandler sends externals to the OS browser.
            if (/^https?:\/\//.test(href)) window.open(href, '_blank', 'noopener');
          }}
          onReferenceHover={setHover}
        />
      </div>
      {/* The icon row is REAL layout (its own vertical space in the thread) — never
          absolutely-positioned overflow, so nothing about scrolling or container edges
          can clip it. Hidden-at-rest is opacity only; the row's space is always there. */}
      <div className="msg__icons">
        {annotate && markableEntityTypes.length > 0 && (
          <DelegationControl
            className="msg__delegctl"
            session={session}
            resourceId={rid}
            entityTypes={markableEntityTypes}
            delegated={delegatedEntityTypes ?? []}
            motivation={prefs.motivation}
            {...(onDelegated !== undefined ? { onComplete: onDelegated } : {})}
          />
        )}
        {annotate && (
          <ShapeControl className="msg__shapectl" mediaType={mediaType} shape={shape} onShapeChange={setShape} />
        )}
        <button
          type="button"
          className={`msg__pencil${annotate ? ' msg__pencil--on' : ''}`}
          onClick={() => setAnnotate((v) => !v)}
          aria-pressed={annotate}
          aria-label={annotate ? 'Stop annotating this message' : 'Annotate this message'}
          title={annotate ? 'Stop annotating this message' : 'Annotate this message'}
        >
          <PencilGlyph />
        </button>
      </div>
      {detail !== null && (
        <AnnotationDetailCard
          session={session}
          annotation={detail.annotation}
          anchorRect={detail.anchorRect}
          annotateMode={annotate}
          onOpenResource={(id) => {
            // The doc opens BESIDE the chat now (split view) — this bubble stays mounted,
            // so the card must dismiss itself; the opened doc is the answer to the click.
            setDetail(null);
            onOpenResource(id, id);
          }}
          onClose={() => setDetail(null)}
        />
      )}
      {hover !== null && (
        <AnchoredHovercard
          session={session}
          resourceId={String(hover.referent['@id'])}
          name={hover.referent.name ?? String(hover.referent['@id'])}
          anchorRect={hover.anchorRect}
          attestation={attestationOf(hover.annotation)}
        />
      )}
      {pending !== null && (
        <PendingCreationPopover session={session} resourceId={rid} pending={pending} onClose={clearPending} />
      )}
      {linkSel !== null &&
        popStyle !== null &&
        !chooserOpen &&
        createPortal(
          <button type="button" className="linksel__cta" style={popStyle} onClick={() => setChooserOpen(true)}>
            🔗 Link “{linkSel.exact.length > 24 ? `${linkSel.exact.slice(0, 24)}…` : linkSel.exact}” to…
          </button>,
          document.body,
        )}
      {linkSel !== null &&
        popStyle !== null &&
        chooserOpen &&
        createPortal(
          <div style={popStyle}>
            <LinkSelectionPopover
              session={session}
              excludeId={resourceId}
              style={{}}
              onPick={(c) => void linkTo(c)}
              onClose={() => {
                setChooserOpen(false);
                setLinkSel(null);
              }}
            />
            {linkError !== null && (
              <p className="linksel__error" role="alert">
                {linkError}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

// The per-message annotate toggle (Lucide pencil) — quiet at rest, accent-filled when active.
function PencilGlyph() {
  return (
    <svg
      width="12"
      height="12"
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
  );
}
