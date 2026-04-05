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
 * - Graph Consumer (event-to-graph projection) — via GraphDBConsumer
 * - Vectors (semantic search) — via VectorStore (optional)
 * - Smelter (event-to-vector projection) — via Smelter (optional)
 *
 * The Gatherer and Matcher are the only actors that read from these stores directly.
 */

import type { EventStore } from '@semiont/event-sourcing';
import { FilesystemViewStorage, type ViewStorage } from '@semiont/event-sourcing';
import { WorkingTreeStore } from '@semiont/content';
import type { GraphDatabase } from '@semiont/graph';
import type { VectorStore } from '@semiont/vectors';
import type { SemiontProject } from '@semiont/core/node';
import type { EventBus, Logger } from '@semiont/core';
import type { EmbeddingProvider, ChunkingConfig } from '@semiont/vectors';
import { GraphDBConsumer } from './graph/consumer.js';
import { Smelter } from './smelter.js';

export interface KnowledgeBase {
  eventStore:    EventStore;
  views:         ViewStorage;
  content:       WorkingTreeStore;
  graph:         GraphDatabase;
  graphConsumer: GraphDBConsumer;
  vectors?:      VectorStore;
  smelter?:      Smelter;
  projectionsDir: string;
}

export interface CreateKnowledgeBaseOptions {
  vectorStore?: VectorStore;
  embeddingProvider?: EmbeddingProvider;
  eventBus?: EventBus;
  chunkingConfig?: ChunkingConfig;
}

export async function createKnowledgeBase(
  eventStore: EventStore,
  project: SemiontProject,
  graphDb: GraphDatabase,
  logger: Logger,
  options?: CreateKnowledgeBaseOptions,
): Promise<KnowledgeBase> {
  const views = new FilesystemViewStorage(project);
  const content = new WorkingTreeStore(
    project,
    logger.child({ component: 'working-tree-store' }),
  );
  const graphConsumer = new GraphDBConsumer(
    eventStore,
    graphDb,
    logger.child({ component: 'graph-consumer' }),
  );
  await graphConsumer.initialize();

  const kb: KnowledgeBase = {
    eventStore, views, content, graph: graphDb, graphConsumer,
    projectionsDir: project.projectionsDir,
  };

  // Initialize vector search if configured
  if (options?.vectorStore && options?.embeddingProvider && options?.eventBus) {
    kb.vectors = options.vectorStore;
    kb.smelter = new Smelter(
      eventStore,
      options.eventBus,
      options.vectorStore,
      options.embeddingProvider,
      content,
      logger.child({ component: 'smelter' }),
      options.chunkingConfig,
    );
    await kb.smelter.initialize();
  }

  return kb;
}
