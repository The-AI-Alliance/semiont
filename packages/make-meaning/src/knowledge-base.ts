/**
 * Knowledge Base
 *
 * The inert store that records what intelligent actors decide.
 * Groups the four KB subsystems from ARCHITECTURE.md:
 *
 * - Event Log (immutable append-only) — via EventStore
 * - Materialized Views (fast single-doc queries) — via ViewStorage
 * - Content Store (working-tree files, URI-addressed) — via WorkingTreeStore
 * - Graph (eventually consistent relationship projection) — via GraphDatabase
 *
 * The Gatherer and Matcher are the only actors that read from these stores directly.
 */

import type { EventStore } from '@semiont/event-sourcing';
import { FilesystemViewStorage, type ViewStorage } from '@semiont/event-sourcing';
import { WorkingTreeStore } from '@semiont/content';
import type { GraphDatabase } from '@semiont/graph';
import type { SemiontProject } from '@semiont/core/node';
import type { Logger } from '@semiont/core';

export interface KnowledgeBase {
  eventStore: EventStore;
  views: ViewStorage;
  content: WorkingTreeStore;
  graph: GraphDatabase;
  projectionsDir: string;
}

export function createKnowledgeBase(
  eventStore: EventStore,
  project: SemiontProject,
  graphDb: GraphDatabase,
  logger: Logger,
): KnowledgeBase {
  const views = new FilesystemViewStorage(project);
  const content = new WorkingTreeStore(
    project,
    logger.child({ component: 'working-tree-store' }),
  );
  return { eventStore, views, content, graph: graphDb, projectionsDir: project.projectionsDir };
}
