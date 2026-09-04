/**
 * The gateway's two byte-proxying calls onto the Archivist's HTTP surface
 * (SINGLE-KB-MOUNT): resource creation writes bytes (`putContent`) and the
 * content pipe reads them back (`getContent`).
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
import type { StoredResource } from '@semiont/content';
import { archivistEndpoint, type ArchivistAddressConfig } from '@semiont/core/node';
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
const archivistSpan = <T>(op: string, run: () => Promise<T>): Promise<T> =>
  withSpan(`archivist.${op}`, run, {
    kind: SpanKind.CLIENT,
    attrs: { 'peer.service': 'archivist' },
  });

/**
 * The KB working tree's current branch, for `/api/status` (SINGLE-KB-MOUNT
 * P5). The gateway used to read this off its own `/kb` mount; the Archivist
 * holds the tree now, so it answers.
 *
 * `undefined` on every failure — unreachable, 401, malformed — because the
 * field is optional and `/api/status` must still answer. A status endpoint
 * that 503s because one optional field could not be filled is worse than one
 * that omits it, and the browser's KB panel already renders a placeholder in
 * the branch slot.
 */
export async function kbBranch(config: ArchivistAddressConfig): Promise<string | undefined> {
  try {
    const { base, headers } = archivistEndpoint(config);
    const res = await archivistSpan('kb.branch', () => fetch(`${base}/kb/branch`, { headers }));
    if (!res.ok) return undefined;
    const { branch } = await res.json() as { branch?: string | null };
    return branch ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a representation's bytes to the record.
 *
 * The `Blob` is handed to `fetch` directly rather than read into a Buffer:
 * undici streams a blob body, so this adds no copy of its own. Note the
 * gateway is still not chunk-bounded end to end — `c.req.formData()` has
 * already materialized the upload before this is called — so the memory win
 * here is the removal of the old `arrayBuffer()` + `Buffer.from()` pair, not
 * the whole of D7. Bounding the multipart parse itself is separate work.
 *
 * The full ledger, so nobody reads "it streams" as more than it is: of the
 * three hops an upload takes, **two stream** (this one, and the Archivist's
 * body → temp file) and **one does not** (`formData()` above). The Archivist
 * used to add a fourth materialization on top — `register` re-read the whole
 * file off disk to verify it on event apply — which is now streamed too
 * (2026-08-31), so exactly one full copy of an upload is held anywhere, in
 * this process, by the multipart parser.
 *
 * No `?checksum` is sent: the gateway has no independent checksum to assert
 * (its old one came FROM the local `store` call this replaces), and the
 * response carries the authoritative one. The query parameter exists for
 * callers that already hold the value.
 *
 * Every failure — unreachable, 401, 503, 500 — maps to one 503. The gateway
 * cannot act differently on any of them, and the distinction belongs in the
 * log rather than in a status code a client cannot use.
 */
export async function putContent(
  config: ArchivistAddressConfig,
  storageUri: string,
  body: Blob,
): Promise<StoredResource> {
  const { base, headers } = archivistEndpoint(config);
  const url = `${base}/content/${encodeURIComponent(storageUri)}`;

  let res: Response;
  try {
    res = await archivistSpan('content.put', () => fetch(url, { method: 'PUT', headers, body }));
  } catch (error) {
    getLogger().error('Archivist content write unreachable', {
      component: 'archivist-client',
      storageUri,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }

  if (!res.ok) {
    getLogger().error('Archivist content write failed', {
      component: 'archivist-client',
      storageUri,
      status: res.status,
      statusText: res.statusText,
    });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }

  return await res.json() as StoredResource;
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
  config: ArchivistAddressConfig,
  resourceId: string,
): Promise<{ body: ReadableStream<Uint8Array>; mediaType: string }> {
  const { base, headers } = archivistEndpoint(config);
  const url = `${base}/resources/${encodeURIComponent(resourceId)}/content`;

  let res: Response;
  try {
    res = await archivistSpan('content.get', () => fetch(url, { headers }));
  } catch (error) {
    getLogger().error('Archivist content read unreachable', {
      component: 'archivist-client',
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HTTPException(503, { message: 'Content store unavailable' });
  }

  if (res.status === 404) {
    const { reason } = await res.json().catch(() => ({})) as { reason?: string };
    throw new HTTPException(404, {
      message: reason === 'representation' ? 'Resource representation not found' : 'Resource not found',
    });
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
