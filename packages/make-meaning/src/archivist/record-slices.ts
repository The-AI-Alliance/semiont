/**
 * Capability slices of the record, and the working tree's bytes behind the
 * shape every reader takes.
 */

import type { EventStore, EventLog, EventReadStorage, ViewMaterializer, ViewStorage } from '@semiont/event-sourcing';
import type { WorkingTreeStore, ContentReads } from '@semiont/content';
import { resolveRepresentation } from '../representation.js';

/**
 * Capability slices of the record.
 *
 * An Archivist actor takes the slice it actually uses. Every slice is DERIVED from the owning type with Pick;
 * a hand-restated shape here would be a mirror of a fact someone else owns.
 */

/** The lifecycle half of the working tree: this seam accessions, moves,
 *  removes and resolves — bytes travel over HTTP, never through it. */
export type ContentLifecycle = Pick<WorkingTreeStore, 'register' | 'move' | 'remove' | 'resolveUri'>;

/**
 * The record's single write seam. `Stower` is the only appendEvent caller
 * anywhere: single-owner by construction. A second caller is a design smell,
 * not a wiring chore.
 *
 * It carries a read — `viewStorage.get`, narrowed to `get` — because one write
 * path is at-least-once and must not duplicate the log: `mark:commit` diffs
 * its batch against what the resource already holds and appends only what is
 * missing. This does NOT reverse the choice of content-addressed annotation
 * ids over read-before-write, which rejected the read for a WORKER reading a
 * REMOTE store mid-recovery — "the thing it would read is exactly what is
 * down". This read is inside the Archivist, against the store it is about to
 * write, and cannot be down relative to itself.
 */
export type EventAppends = Pick<EventStore, 'appendEvent'> & {
  readonly viewStorage: Pick<ViewStorage, 'get'>;
  /**
   * The raw log, for the one read a write needs before it appends: a cited
   * job's `job:assigned` on this resource, to check the holder and derive the
   * requester. Scoped by resource, as the log is.
   */
  readonly log: Pick<EventLog, 'getEvents'>;
};

/** Read-only reach into the event store: the log for queries, the
 *  materializer for on-demand view assembly (`assembleResourceGraph`). */
export interface EventStoreReads {
  log: { storage: EventReadStorage };
  views: { materializer: Pick<ViewMaterializer, 'materialize'> };
}

/**
 * In-process `ContentReads`: the BUFFERING face of `resolveRepresentation` —
 * the same stored bytes the HTTP face serves verbatim, collected because the
 * transport contract hands back an ArrayBuffer. The resolution itself — the
 * one every reader shares — lives in `representation.ts` and is not restated
 * here.
 */
export function workingTreeContentReads(
  views: Pick<ViewStorage, 'get'>,
  content: Pick<WorkingTreeStore, 'retrieveStream'>,
): ContentReads {
  return {
    getBinary: async (resourceId) => {
      const { stream, mediaType } = await resolveRepresentation({ views, content }, resourceId);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      const data = new ArrayBuffer(buf.byteLength);
      new Uint8Array(data).set(buf);
      return { data, contentType: mediaType };
    },
  };
}
