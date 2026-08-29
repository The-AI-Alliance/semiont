/**
 * The gateway's client for the Archivist's HTTP surface (SINGLE-KB-MOUNT).
 *
 * Two callers: SSE resume reads the record (`fetchArchivistReplay`,
 * routes/bus.ts) and resource creation writes bytes (`putContent`, below).
 * They share ONE resolution of where the Archivist is and how we prove who
 * we are — the address and the secret are deployment facts, and a second
 * copy of either is a second thing to get wrong.
 *
 * Both fail loudly when absent. A missing host or secret is a
 * misconfiguration, never a reason to fall back to writing locally: the
 * point of SINGLE-KB-MOUNT is that exactly one process writes the tree
 * (D7 accepts the availability cost that buys).
 */

import { HTTPException } from 'hono/http-exception';
import type { StoredResource } from '@semiont/content';
import { getLogger } from '../logger';

/** The slice of EnvironmentConfig this module reads — nothing wider. */
export interface ArchivistAddressConfig {
  services?: { archivist?: { host?: string; port?: number } };
}

/**
 * Base URL and auth header for the Archivist, resolved together because they
 * are useless apart. Throws on either absence.
 */
export function archivistEndpoint(config: ArchivistAddressConfig): {
  base: string;
  headers: { authorization: string };
} {
  const host = config.services?.archivist?.host;
  if (!host) {
    throw new Error('services.archivist.host is not configured — cannot reach the record');
  }
  const port = config.services?.archivist?.port ?? 9093;
  const secret = process.env.SEMIONT_WORKER_SECRET;
  if (!secret) {
    throw new Error('SEMIONT_WORKER_SECRET is not set — cannot authenticate to the Archivist');
  }
  return { base: `http://${host}:${port}`, headers: { authorization: `Bearer ${secret}` } };
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
    res = await fetch(url, { method: 'PUT', headers, body });
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
