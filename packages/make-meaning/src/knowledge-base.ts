/**
 * Knowledge Base
 *
 * The inert store that records what intelligent actors decide.
 * Groups the four KB subsystems from ARCHITECTURE.md:
 *
 * - Event Log (immutable append-only) — via EventStore
 * - Materialized Views (fast single-doc queries) — via ViewStorage
 * - Content Store (SHA-256 addressed, deduplicated) — via RepresentationStore
 * - Graph (eventually consistent relationship projection) — via GraphDatabase
 *
 * The Gatherer and Matcher are the only actors that read from these stores directly.
 */

import type { EventStore } from '@semiont/event-sourcing';
import { FilesystemViewStorage, type ViewStorage } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore, type RepresentationStore } from '@semiont/content';
import type { GraphDatabase } from '@semiont/graph';
import type { Logger, SemiontProject } from '@semiont/core';

export interface KnowledgeBase {
  eventStore: EventStore;
  views: ViewStorage;
  content: RepresentationStore;
  graph: GraphDatabase;
}

export function createKnowledgeBase(
  eventStore: EventStore,
  project: SemiontProject,
  graphDb: GraphDatabase,
  logger: Logger,
): KnowledgeBase {
  const views = new FilesystemViewStorage(project);
  const content = new FilesystemRepresentationStore(
    project,
    logger.child({ component: 'representation-store' }),
  );
  return { eventStore, views, content, graph: graphDb };
}
