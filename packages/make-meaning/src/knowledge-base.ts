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
 * - Vectors (semantic search) — via VectorStore (optional, read-only)
 *
 * The Smelter (event-to-vector projection) runs as an external actor
 * via @semiont/make-meaning/smelter-main. It subscribes to domain events
 * via the EventBus gateway, embeds content, and writes to Qdrant directly.
 */

import type { EventStore } from '@semiont/event-sourcing';
import { FilesystemViewStorage, type ViewStorage } from '@semiont/event-sourcing';
import { WorkingTreeStore } from '@semiont/content';
import type { GraphDatabase } from '@semiont/graph';
import type { VectorStore } from '@semiont/vectors';
import type { SemiontProject } from '@semiont/core/node';
import type { EventBus, Logger } from '@semiont/core';
import { createWeaveProgress, type WeaveProgress } from './weave-progress.js';

export interface KnowledgeBase {
  eventStore:    EventStore;
  views:         ViewStorage;
  content:       WorkingTreeStore;
  graph:         GraphDatabase;
  weaveProgress: WeaveProgress;
  vectors?:      VectorStore;
  projectionsDir: string;
}

export interface CreateKnowledgeBaseOptions {
  vectorStore?: VectorStore;
  skipRebuild?: boolean;
}

export async function createKnowledgeBase(
  eventStore: EventStore,
  project: SemiontProject,
  graphDb: GraphDatabase,
  eventBus: EventBus,
  logger: Logger,
  options?: CreateKnowledgeBaseOptions,
): Promise<KnowledgeBase> {
  const views = new FilesystemViewStorage(project, logger.child({ component: 'view-storage' }));
  const content = new WorkingTreeStore(
    project,
    logger.child({ component: 'working-tree-store' }),
  );
  // Fold of `weave:applied` signals. The Weaver itself is NOT constructed
  // here (WEAVER-ISOLATION D4, refined): the graph projection is part of
  // the graph stack, not the embedding process — `weaver-main` runs it as
  // a standalone actor, and its signals arrive over the bus. This fold is
  // the backend-side half, wherever the Weaver runs.
  const weaveProgress = createWeaveProgress(eventBus);

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
    eventStore, views, content, graph: graphDb, weaveProgress,
    projectionsDir: project.projectionsDir,
  };

  if (options?.vectorStore) {
    kb.vectors = options.vectorStore;
  }

  return kb;
}
