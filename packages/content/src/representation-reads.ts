/**
 * Reading a resource's bytes: the contract, the way it fails, and the
 * implementation that reaches the Archivist over HTTP.
 *
 * These live in `@semiont/content` because this package IS the byte layer —
 * the Archivist's whole job — and because the readers span the dependency
 * graph. `@semiont/make-meaning` holds the Archivist itself and satisfies
 * `ContentReads` in-process from the working tree; `@semiont/jobs` holds the
 * Worker and can only reach the record over the wire. make-meaning depends on
 * jobs, so anything both need has to sit under both.
 *
 * Where the Archivist IS lives in `@semiont/core/node` (`archivistEndpoint`),
 * not here: an address is a config value plus a credential, which is what
 * that module resolves. One resolution — the address and the credential are
 * deployment facts, and a second copy of either is a second thing to get
 * wrong.
 *
 * Absence fails loudly. A missing host or secret is a misconfiguration, never
 * a reason to fall back to reading a tree locally — the point of the single
 * KB mount is that exactly one process, the Archivist, touches the tree.
 */

import type { IContentTransport, ResourceId } from '@semiont/core';
import { archivistAddress, archivistEndpoint, type ArchivistAddressConfig } from '@semiont/core/node';
import type { ServiceAccountCredential, components } from '@semiont/core';
import { validators } from '@semiont/core/openapi';

/**
 * The byte read, and nothing else — DERIVED from the transport contract so it
 * cannot drift from it. Keyed by ResourceId because that is the transport's
 * key and the Archivist's: no caller converts to a tree address only to have
 * the far side convert back.
 */
export type ContentReads = Pick<IContentTransport, 'getBinary'>;

/** Which half of the lookup failed — the `code` of the Archivist's RepresentationNotFound. */
export type MissingReason = components['schemas']['RepresentationNotFound']['code'];

export class RepresentationMissing extends Error {
  constructor(readonly resourceId: string, readonly reason: MissingReason) {
    // NAMES THE RESOURCE. The client-visible wording is the gateway's, built
    // from `reason` — so this message is free to be diagnostic, and must be:
    // an operator reading a log needs to know which resource.
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
 * mount reads bytes: the Smelter, Worker and Librarian fetch them from the
 * Archivist over HTTP rather than through the gateway.
 *
 * The address resolves HERE, at construction, not per read: a process with no
 * Archivist configured must die while an operator is watching it boot, rather
 * than fail every resource for the life of the process.
 *
 * A miss arrives as `RepresentationMissing` — the same error the in-process
 * face throws for the same fact, so no caller can tell whether the bytes were
 * a hop away. The Archivist's `code` says which half failed, precisely so this
 * side need not guess; a 404 without one is a broken Archivist, not a miss.
 */
export function archivistContentReads(
  config: ArchivistAddressConfig,
  credential: ServiceAccountCredential,
): ContentReads {
  // Boot-time, not first-read: a Smelter with no Archivist address must die
  // while an operator is watching, not fail every resource quietly. Only the
  // TOKEN is deferred, because only the token is async.
  archivistAddress(config, credential);

  return {
    getBinary: async (resourceId: ResourceId) => {
      // Resolved per read, not once at construction: the credential is a
      // token, and one held for the life of the process would expire in it. The
      // issuer round trip is not per read — `serviceAccountToken` keeps the
      // token until shortly before the lifetime the grant reported.
      const { base, headers } = await archivistEndpoint(config, credential);
      const url = `${base}/resources/${encodeURIComponent(String(resourceId))}/content`;
      const res = await fetch(url, { headers });

      if (res.status === 404) {
        const notFound: unknown = await res.json().catch(() => undefined);
        if (!validators.RepresentationNotFound(notFound)) {
          throw new Error(`Archivist content read for ${String(resourceId)}: a 404 that is not a RepresentationNotFound`);
        }
        throw new RepresentationMissing(String(resourceId), notFound.code);
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
