/**
 * Reading a resource's bytes: the contract, the way it fails, and the
 * implementation that reaches the Archivist over HTTP.
 *
 * These live in `@semiont/content` because this package IS the byte layer —
 * the Archivist's whole job — and because the readers span the dependency
 * graph. `@semiont/make-meaning` holds the Archivist itself and satisfies
 * `ContentReads` in-process from the working tree; `@semiont/jobs` holds the
 * Worker and can only reach the record over the wire. make-meaning depends on
 * jobs, so anything both need has to sit under both (SINGLE-KB-MOUNT P4).
 *
 * Where the Archivist IS lives in `@semiont/core/node` (`archivistEndpoint`),
 * not here: an address is a config value plus an environment variable, and
 * the gateway needs it without needing a byte reader. One resolution, shared
 * with the gateway's own proxying — the address and the secret are deployment
 * facts, and a second copy of either is a second thing to get wrong.
 *
 * Absence fails loudly. A missing host or secret is a misconfiguration, never
 * a reason to fall back to reading a tree locally — the point of
 * SINGLE-KB-MOUNT is that exactly one process touches it.
 */

import type { IContentTransport, ResourceId } from '@semiont/core';
import { archivistEndpoint, type ArchivistAddressConfig } from '@semiont/core/node';

/**
 * The byte read, and nothing else — DERIVED from the transport contract so it
 * cannot drift from it. Keyed by ResourceId because that is the transport's
 * key and the Archivist's: no caller converts to a tree address only to have
 * the far side convert back.
 */
export type ContentReads = Pick<IContentTransport, 'getBinary'>;

/** Which half of the lookup failed — the gateway serves two different 404s. */
export type MissingReason = 'resource' | 'representation';

export class RepresentationMissing extends Error {
  constructor(readonly resourceId: string, readonly reason: MissingReason) {
    // NAMES THE RESOURCE. The client-visible wording is the gateway's, built
    // from `reason` — so this message is free to be diagnostic, and must be:
    // an operator reading a log needs to know which resource, which is what
    // the pre-collapse message gave them.
    super(
      reason === 'resource'
        ? `Resource not found: ${resourceId}`
        : `Resource representation not found: no storageUri for ${resourceId}`,
    );
    this.name = 'RepresentationMissing';
  }
}

/**
 * `ContentReads` against the Archivist — how a fleet process that holds no KB
 * mount reads bytes (SINGLE-KB-MOUNT P4).
 *
 * The address resolves HERE, at construction, not per read: a process with no
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
