import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useMediaToken, useResourceLoader } from '@semiont/react-ui';
import {
  capabilitiesOf,
  decodeWithCharset,
  getPrimaryMediaType,
  getResourceEntityTypes,
  getStorageUri,
} from '@semiont/core';
import { resourceId as brandResourceId } from '@semiont/sdk';
import type { Attestation } from '../lib/attestation';
import type { ChatSession } from '../lib/session';

const PEEK_CHARS = 260;
const CARD_WIDTH = 320;

/**
 * A `ResourceHovercard` portalled to `document.body` and positioned off an anchor rect —
 * above it when there's room, below near the viewport top, clamped horizontally. Shared by
 * every hover surface (viewer reference spans, compose-time mention chips) so the card sits
 * identically everywhere. Non-interactive (`.rcard-anchor` is pointer-events: none).
 */
export function AnchoredHovercard({
  session,
  resourceId,
  name,
  anchorRect,
  attestation,
}: {
  session: ChatSession;
  resourceId: string;
  name: string;
  anchorRect: DOMRect;
  /** The hovered ANNOTATION's provenance (By/Via — the Browser's panel attestation),
   *  when the hover surface is an annotation rather than a bare resource chip. */
  attestation?: Attestation | null;
}) {
  const style: CSSProperties = useMemo(() => {
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - CARD_WIDTH - 8);
    const base: CSSProperties = { position: 'fixed', left, width: CARD_WIDTH };
    return anchorRect.top > 260
      ? { ...base, bottom: window.innerHeight - anchorRect.top + 6 }
      : { ...base, top: anchorRect.bottom + 6 };
  }, [anchorRect]);
  return createPortal(
    <div className="rcard-anchor" style={style}>
      <ResourceHovercard session={session} resourceId={resourceId} name={name} />
      {attestation != null && (
        <p className="rcard__attest">
          By {attestation.by}
          {attestation.when !== undefined && <> · {attestation.when}</>}
          {attestation.via !== undefined && <> · Via {attestation.via}</>}
        </p>
      )}
    </div>,
    document.body,
  );
}

/**
 * The preview shown when a `ResourceChip` is hovered: identity (full name + path/URI the chip
 * abbreviates), metadata (media type, entity types, annotation count), and a peek (a text excerpt,
 * or a thumbnail for an image). Loads lazily from OUR `SemiontSession` — the same descriptor +
 * content path the main-pane `ResourceView` uses — so it only fetches while a chip is actually
 * hovered (the parent mounts this on dwell).
 */
export function ResourceHovercard({
  session,
  resourceId,
  name,
  fileUri,
}: {
  session: ChatSession;
  resourceId: string;
  name: string;
  /** The uploaded file's URI, when known — shown as the path without a fetch. */
  fileUri?: string;
}) {
  const rid = useMemo(() => brandResourceId(resourceId), [resourceId]);
  const { resource, annotations, loading, error } = useResourceLoader(session.client, rid);

  const mediaType = resource ? getPrimaryMediaType(resource) || 'text/plain' : undefined;
  const render = mediaType ? capabilitiesOf(mediaType)?.render : undefined;
  const isImage = render === 'image';
  const isBinary = isImage || render === 'pdf';

  // Text excerpt (skipped for binary media).
  const [excerpt, setExcerpt] = useState<string | null>(null);
  useEffect(() => {
    if (resource === undefined || isBinary) return undefined;
    let cancelled = false;
    void session.client.browse
      .resourceRepresentation(rid)
      .then(({ data, contentType }) => {
        if (!cancelled) setExcerpt(decodeWithCharset(data, contentType).slice(0, PEEK_CHARS).trim());
      })
      .catch(() => {
        if (!cancelled) setExcerpt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session, rid, resource, isBinary]);

  // Image thumbnail via a short-lived, authed media-token URL (only fetched for images).
  const { token } = useMediaToken(isImage ? session.client : null, rid);
  const thumbUrl = isImage && token ? `${session.client.baseUrl}/api/resources/${rid}?token=${token}` : null;

  const path = fileUri ?? getStorageUri(resource) ?? resourceId;
  const displayName = resource?.name ?? name;
  const entityTypes = getResourceEntityTypes(resource);
  const referenceCount = annotations.references.length;

  return (
    <div className="rcard" role="tooltip">
      <div className="rcard__head">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="rcard__name">{displayName}</span>
      </div>
      <div className="rcard__path" title={path}>
        {path}
      </div>

      {error !== null ? (
        <div className="rcard__status">Couldn’t load details.</div>
      ) : loading || resource === undefined ? (
        <div className="rcard__status">Loading…</div>
      ) : (
        <>
          <div className="rcard__meta">
            {mediaType && <span className="rcard__badge">{mediaType}</span>}
            {entityTypes.map((t) => (
              <span key={t} className="rcard__badge rcard__badge--type">
                {t}
              </span>
            ))}
            <span className="rcard__count">
              {referenceCount} reference{referenceCount === 1 ? '' : 's'}
            </span>
          </div>
          {thumbUrl ? (
            <img className="rcard__thumb" src={thumbUrl} alt={displayName} />
          ) : render === 'pdf' ? (
            <div className="rcard__peek rcard__peek--muted">PDF document</div>
          ) : excerpt !== null && excerpt.length > 0 ? (
            <div className="rcard__peek">{excerpt}</div>
          ) : null}
        </>
      )}
    </div>
  );
}
