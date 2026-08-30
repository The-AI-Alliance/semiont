/**
 * Where the Archivist is, how a caller proves who it is, and the byte read
 * that rides that address (SINGLE-KB-MOUNT P3/P4).
 *
 * The server half is `archivist-read-path.ts`, in this package. The client
 * lives beside it deliberately: each route string is stated once per
 * direction, adjacent, so a path cannot move on only one side.
 *
 * Four callers share ONE resolution of the address and the secret — the
 * gateway's SSE resume and its content proxying (apps/backend/src/lib/
 * archivist.ts), and the Smelter's and Librarian's byte reads. The address
 * and the secret are deployment facts, and a second copy of either is a
 * second thing to get wrong.
 *
 * Both fail loudly when absent. A missing host or secret is a
 * misconfiguration, never a reason to fall back to reading the tree locally:
 * the point of SINGLE-KB-MOUNT is that exactly one process touches it.
 */

import type { ArchivistServiceConfig, ResourceId } from '@semiont/core';
import type { ContentReads } from './knowledge-base';
import { RepresentationMissing } from './representation';

/**
 * The slice of config this module reads — nothing wider, and DERIVED from
 * the schema's own service type rather than restating `host`/`port`.
 */
export interface ArchivistAddressConfig {
  services?: { archivist?: Pick<ArchivistServiceConfig, 'host' | 'port'> };
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
 * `ContentReads` against the Archivist — how a fleet process that holds no KB
 * mount reads bytes (SINGLE-KB-MOUNT P4).
 *
 * The address resolves HERE, at construction, not per read: a Smelter with no
 * Archivist configured must die while an operator is watching it boot, rather
 * than fail every resource for the life of the process.
 *
 * A miss arrives as `RepresentationMissing` — the same error the in-process
 * face throws for the same fact, so no caller can tell whether the bytes were
 * a hop away. `reason` rides the wire precisely so this side need not guess.
 */
export function archivistContentReads(config: ArchivistAddressConfig): ContentReads {
  const { base, headers } = archivistEndpoint(config);

  return {
    getBinary: async (resourceId: ResourceId) => {
      const url = `${base}/resources/${encodeURIComponent(String(resourceId))}/content`;
      const res = await fetch(url, { headers });

      if (res.status === 404) {
        const { reason } = await res.json().catch(() => ({})) as { reason?: string };
        throw new RepresentationMissing(
          String(resourceId),
          reason === 'representation' ? 'representation' : 'resource',
        );
      }
      if (!res.ok) {
        throw new Error(`Archivist content read failed for ${String(resourceId)}: ${res.status} ${res.statusText}`);
      }

      return {
        data: await res.arrayBuffer(),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      };
    },
  };
}
