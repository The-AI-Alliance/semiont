/**
 * Knowledge Base
 *
 * The durable store that records what intelligent actors decide.
 * Groups the KB subsystems from ARCHITECTURE.md:
 *
 * - Event Log (immutable append-only) — via EventStore
 * - Materialized Views (fast single-doc queries) — via ViewStorage
 * - Content Store (working-tree files, URI-addressed) — via WorkingTreeStore
 * - Graph (eventually consistent relationship projection) — via GraphDatabase
 * - WeaveProgress (weave:applied fold — the graph-projection barrier; the
 *   Weaver itself runs standalone via @semiont/make-meaning/weaver-main)
 * - SmeltProgress (smelt:settled fold — the vector-projection barrier;
 *   SMELTER-INDEX-SYNC, same standalone-actor arrangement as the Weaver)
 * - Vectors (semantic search) — via VectorStore (optional, read-only)
 *
 * The Smelter (event-to-vector projection) runs as an external actor
 * via @semiont/make-meaning/smelter-main. It subscribes to domain events
 * via the EventBus gateway, embeds content, and writes to Qdrant directly.
 */

import type { EventStore, EventReadStorage, ViewMaterializer } from '@semiont/event-sourcing';
import { FilesystemViewStorage, type ViewStorage } from '@semiont/event-sourcing';
import { WorkingTreeStore, createAnchoredTextStore, type AnchoredTextStore } from '@semiont/content';
import type { GraphDatabase } from '@semiont/graph';
import type { VectorStore } from '@semiont/vectors';
import type { SemiontProject } from '@semiont/core/node';
import type { EventBus, IContentTransport, Logger } from '@semiont/core';
import { getPrimaryRepresentation } from '@semiont/core';
import { createWeaveProgress, type WeaveProgress } from './weave-progress.js';
import { createSmeltProgress, type SmeltProgress } from './smelt-progress.js';

export interface KnowledgeBase {
  eventStore:    EventStore;
  views:         ViewStorage;
  content:       WorkingTreeStore;
  /** Derived coordinate maps for resources whose text had to be recovered. */
  anchoredText:  AnchoredTextStore;
  graph:         GraphDatabase;
  weaveProgress: WeaveProgress;
  smeltProgress: SmeltProgress;
  vectors:       VectorStore;
  projectionsDir: string;
}

/**
 * Capability slices of the record (EXTRACT-ARCHIVIST P1).
 *
 * An Archivist actor takes the slice it actually uses, never the whole
 * KnowledgeBase. Every slice is DERIVED from the owning type with Pick;
 * a hand-restated shape here would be a mirror of a fact someone else owns.
 */

/** The lifecycle half of the working tree (GATEWAY.md D4a): the Archivist
 *  accessions, moves, removes and resolves — it never serves bytes. */
export type ContentLifecycle = Pick<WorkingTreeStore, 'register' | 'move' | 'remove' | 'resolveUri'>;

/** The record's single write seam. `Stower` is the only appendEvent caller
 *  anywhere in make-meaning or the gateway (post-#1252): single-owner by
 *  construction. A second caller is a design smell, not a wiring chore. */
export type EventAppends = Pick<EventStore, 'appendEvent'>;

/** Read-only reach into the event store: the log for queries, the
 *  materializer for on-demand view assembly (`assembleResourceGraph`). */
export interface EventStoreReads {
  log: { storage: EventReadStorage };
  views: { materializer: Pick<ViewMaterializer, 'materialize'> };
}

/**
 * The gather paths' byte read (EXTRACT-LIBRARIAN P3, D-CONTENT b) — DERIVED
 * from the transport contract, never restated. Keyed by ResourceId because
 * that is the transport's key: the standalone Librarian satisfies this with
 * `HttpContentTransport` directly, and in-process roots wrap the working
 * tree behind the same shape via `workingTreeContentReads`.
 */
export type ContentReads = Pick<IContentTransport, 'getBinary'>;

/**
 * In-process `ContentReads`: resolve the descriptor from the view, then read
 * the working tree — the same stored bytes the HTTP face serves verbatim.
 * `contentType` mirrors the transport contract (the stored representation's
 * mediaType, with the transport's own octet-stream fallback); gather
 * consumers decode via the descriptor and ignore it.
 */
export function workingTreeContentReads(
  views: Pick<ViewStorage, 'get'>,
  content: Pick<WorkingTreeStore, 'retrieve'>,
): ContentReads {
  return {
    getBinary: async (resourceId) => {
      const view = await views.get(resourceId);
      const resource = view?.resource;
      if (!resource?.storageUri) {
        throw new Error(`Resource content not found: no storageUri for ${String(resourceId)}`);
      }
      const buf = await content.retrieve(resource.storageUri);
      const data = new ArrayBuffer(buf.byteLength);
      new Uint8Array(data).set(buf);
      return {
        data,
        contentType: getPrimaryRepresentation(resource)?.mediaType ?? 'application/octet-stream',
      };
    },
  };
}

export interface CreateKnowledgeBaseOptions {
  /** Required (MANDATORY-EMBEDDING D0): a KB without vector search is not a
   *  configuration we support; `MemoryVectorStore` is the explicit named
   *  choice for stores that may rebuild on restart. */
  vectorStore: VectorStore;
  skipRebuild?: boolean;
}

export async function createKnowledgeBase(
  eventStore: EventStore,
  project: SemiontProject,
  graphDb: GraphDatabase,
  eventBus: EventBus,
  logger: Logger,
  options: CreateKnowledgeBaseOptions,
): Promise<KnowledgeBase> {
  const views = new FilesystemViewStorage(project, logger.child({ component: 'view-storage' }));
  const content = new WorkingTreeStore(
    project,
    logger.child({ component: 'working-tree-store' }),
  );
  // Derived coordinate maps, beside the content they describe. The
  // KnowledgeSystem owns this for the same reason it owns `content`: every
  // other process reaches it through `IContentTransport`, so there is exactly
  // one storage authority and no shared volume between service images
  // (ANCHORED-TEXT-CACHE Lane 5).
  const anchoredText = createAnchoredTextStore(
    project.anchoredTextDir,
    logger.child({ component: 'anchored-text-store' }),
  );
  // Fold of `weave:applied` signals. The Weaver itself is NOT constructed
  // here (WEAVER-ISOLATION D4, refined): the graph projection is part of
  // the graph stack, not the embedding process — `weaver-main` runs it as
  // a standalone actor, and its signals arrive over the bus. This fold is
  // the backend-side half, wherever the Weaver runs.
  const weaveProgress = createWeaveProgress(eventBus);
  // Its vector-projection sibling: fold of `smelt:settled` decision signals
  // from the standalone Smelter, backing the gather-side read-your-writes
  // barrier (SMELTER-INDEX-SYNC D1 = push).
  const smeltProgress = createSmeltProgress(eventBus);

  if (!options?.skipRebuild) {
    // Rebuild materialized views from the event log first. The Browser actor
    // reads from these views, so they must be populated before any request is
    // served. The graph projection no longer full-rebuilds here — the Weaver
    // catches up incrementally via its checkpoint (WEAVER-ISOLATION P3),
    // called from startMakeMeaning once the Browser is serving the
    // `browse:*` reads catch-up rides on.
    await eventStore.views.rebuildAll(eventStore.log);
  }

  const kb: KnowledgeBase = {
    eventStore, views, content, anchoredText, graph: graphDb, weaveProgress, smeltProgress,
    vectors: options.vectorStore,
    projectionsDir: project.projectionsDir,
  };

  return kb;
}
