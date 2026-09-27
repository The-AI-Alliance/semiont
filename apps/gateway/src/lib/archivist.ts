/**
 * The gateway's calls onto the Archivist's HTTP surface: an upload is stored
 * and recorded there (`recordUpload`), the content pipe reads bytes back
 * (`getContent`), and a resource's linked-data description is read there
 * (`describeResource`). The gateway parses none of it: it forwards, and maps
 * the Archivist's answer onto its own responses.
 *
 * Where the Archivist is and how we prove who we are lives in
 * `@semiont/core/node` — the address and the secret are deployment facts, and
 * a second copy of either is a second thing to get wrong. The Smelter, the
 * Librarian and the Worker resolve them the same way (P4).
 *
 * Both fail loudly when absent. A missing host or secret is a
 * misconfiguration, never a reason to fall back to writing locally: the
 * point of SINGLE-KB-MOUNT is that exactly one process writes the tree
 * (D7 accepts the availability cost that buys).
 */

import { HTTPException } from 'hono/http-exception';
import { errField, isObject, isString } from '@semiont/core';
import type { StoredEvent, ServiceAccountCredential } from '@semiont/core';
import { archivistEndpoint, type ArchivistAddressConfig } from '@semiont/core/node';
import { validators } from '@semiont/core/openapi';
import { SpanKind, withSpan } from '@semiont/observability';
import { getLogger } from '../logger';

/**
 * Every call here crosses to the Archivist, so every call is a CLIENT span.
 *
 * The documented model (OBSERVABILITY.md) pairs a `content.*` client span with
 * a `content.*.server` span and stops — it was written when the gateway WAS the
 * content store. SINGLE-KB-MOUNT added this third hop underneath the server
 * span, so `content.put.server`'s duration has since included a full Archivist
 * round-trip while attributing none of it: a slow Archivist rendered as a slow
 * gateway. These spans put the time where it is spent.
 */
/** Where the Archivist is, and the gateway's own account to reach it with — resolved once, at boot. */
export interface ArchivistAccess {
  address: ArchivistAddressConfig;
  credential: ServiceAccountCredential;
}

const endpoint = (archivist: ArchivistAccess) => archivistEndpoint(archivist.address, archivist.credential);

const archivistSpan = <T>(op: string, run: () => Promise<T>): Promise<T> =>
  withSpan(`archivist.${op}`, run, {
    kind: SpanKind.CLIENT,
    attrs: { 'peer.service': 'archivist' },
  });

/** Who an upload is recorded for — the principal this gateway verified. */
export interface UploadPrincipal {
  did: string;
  roles: readonly string[];
}

/**
 * Forward a client's upload to the Archivist, which stores the bytes and
 * records the resource, and answer the new resource's id.
 *
 * The multipart body is streamed through untouched — the gateway neither
 * parses nor holds it — with the principal it verified named in
 * `Semiont-Principal` and `Semiont-Roles`. The Archivist's 400 (a malformed
 * upload) and 500 (the record refused it) come back with its message; it being
 * unreachable, or refusing this gateway's own credential, is a 503.
 */
export async function recordUpload(
  archivist: ArchivistAccess,
  upload: { body: ReadableStream<Uint8Array> | null; contentType: string },
  principal: UploadPrincipal,
): Promise<string> {
  const { base, headers } = await endpoint(archivist);
  const forwarded: Record<string, string> = {
    ...headers,
    'content-type': upload.contentType,
    'semiont-principal': principal.did,
    ...(principal.roles.length > 0 ? { 'semiont-roles': principal.roles.join(',') } : {}),
  };

  let res: Response;
  try {
    res = await archivistSpan('resources.record', () =>
      fetch(`${base}/resources`, { method: 'POST', headers: forwarded, body: upload.body, duplex: 'half' }),
    );
  } catch (error) {
    getLogger().error('Archivist unreachable for an upload', { component: 'archivist-client', error: errField(error) });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }

  const answer: unknown = await res.json().catch(() => undefined);
  if (res.ok && isObject(answer) && isString(answer['resourceId'])) return answer['resourceId'];
  if ((res.status === 400 || res.status === 500) && isObject(answer) && isString(answer['error'])) {
    throw new HTTPException(res.status, { message: answer['error'] });
  }
  getLogger().error('Archivist upload failed', { component: 'archivist-client', status: res.status, statusText: res.statusText });
  throw new HTTPException(503, { message: 'Content store unavailable' });
}

/**
 * A resource's linked-data description, read from the Archivist; undefined
 * when it holds no such resource.
 */
export async function describeResource(
  archivist: ArchivistAccess,
  resourceId: string,
): Promise<unknown> {
  const { base, headers } = await endpoint(archivist);
  let res: Response;
  try {
    res = await archivistSpan('resources.describe', () =>
      fetch(`${base}/resources/${encodeURIComponent(resourceId)}/jsonld`, { headers }),
    );
  } catch (error) {
    getLogger().error('Archivist unreachable for a description', { component: 'archivist-client', resourceId, error: errField(error) });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }
  if (res.status === 404) return undefined;
  if (!res.ok) {
    getLogger().error('Archivist description failed', { component: 'archivist-client', resourceId, status: res.status, statusText: res.statusText });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }
  return res.json();
}

/**
 * Read a representation's bytes back from the record (SINGLE-KB-MOUNT P3).
 *
 * Returns the response body as a stream — the gateway pipes it to its client
 * rather than buffering, so its memory is bounded by the chunk and not by the
 * largest representation anyone requests (D7's compensating gain, and the
 * half of it the read path can actually deliver end to end).
 *
 * Addressed by resourceId because the Archivist owns the resolution of
 * *where a resource's bytes are and what type they are*; the gateway has
 * deliberately stopped deciding that. `reason` on the 404 carries which half
 * of the lookup failed, so the two client-visible messages this route has
 * always served are preserved without the gateway reading a view.
 */
export async function getContent(
  archivist: ArchivistAccess,
  resourceId: string,
): Promise<{ body: ReadableStream<Uint8Array>; mediaType: string }> {
  const { base, headers } = await endpoint(archivist);
  const url = `${base}/resources/${encodeURIComponent(resourceId)}/content`;

  let res: Response;
  try {
    res = await archivistSpan('content.get', () => fetch(url, { headers }));
  } catch (error) {
    getLogger().error('Archivist content read unreachable', {
      component: 'archivist-client',
      resourceId,
      error: errField(error),
    });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }

  if (res.status === 404) {
    const notFound: unknown = await res.json().catch(() => undefined);
    if (validators.RepresentationNotFound(notFound)) {
      throw new HTTPException(404, {
        message: notFound.code === 'representation' ? 'Resource representation not found' : 'Resource not found',
      });
    }
    getLogger().error('Archivist answered a 404 that is not a RepresentationNotFound', { component: 'archivist-client', resourceId });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }

  if (!res.ok || !res.body) {
    getLogger().error('Archivist content read failed', {
      component: 'archivist-client',
      resourceId,
      status: res.status,
      statusText: res.statusText,
    });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }

  return { body: res.body, mediaType: res.headers.get('content-type') || 'application/octet-stream' };
}

/**
 * The events for one resource from one sequence, inclusive — the Archivist's
 * D1 read path behind `/bus/subscribe`'s replay (EXTRACT-ARCHIVIST). What may
 * live on the Archivist's HTTP surface at all is decided in ONE place, the
 * standing rule in `archivist-read-path.ts`. A failure throws; the caller
 * degrades it to a scoped `bus:resume-gap`, the honest answer when the record
 * cannot be read.
 */
export async function replayEvents(
  archivist: ArchivistAccess,
  resourceId: string,
  fromSequence: number,
): Promise<StoredEvent[]> {
  const { base, headers } = await endpoint(archivist);
  const res = await archivistSpan('events.replay', () =>
    fetch(`${base}/events/${encodeURIComponent(resourceId)}?fromSequence=${fromSequence}`, { headers }),
  );
  if (!res.ok) {
    throw new Error(`Archivist replay read failed: ${res.status} ${res.statusText}`);
  }
  const { events } = await res.json() as { events: StoredEvent[] };
  return events;
}
