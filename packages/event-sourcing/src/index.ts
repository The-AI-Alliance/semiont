/**
 * @semiont/event-sourcing
 *
 * Event sourcing infrastructure for Semiont
 *
 * Provides:
 * - EventStore: Orchestration layer for event sourcing
 * - EventLog: Event persistence (append, retrieve, query)
 * - EventBus: Pub/sub notifications (publish, subscribe)
 * - ViewManager: View materialization (resource and system)
 * - ViewStorage: Interface and filesystem implementation for materialized views
 */

// Core event sourcing components
export { EventStore } from './event-store';
export { createEventStore } from './event-store-factory';
export { EventLog, type EventLogConfig } from './event-log';
export { EventBus, type EventBusConfig } from './event-bus';
export { ViewManager, type ViewManagerConfig } from './view-manager';

// Storage
export { type EventStorageConfig } from './storage/event-storage';
export { EventStorage } from './storage/event-storage';
export {
  type ViewStorage,
  type ResourceView,
  FilesystemViewStorage,
} from './storage/view-storage';
export { getShardPath, sha256, jumpConsistentHash } from './storage/shard-utils';

// Subscriptions
export {
  type EventCallback,
  type EventSubscription,
  EventSubscriptions,
  getEventSubscriptions,
} from './subscriptions/event-subscriptions';

// Query
export { EventQuery } from './query/event-query';

// Validation
export { EventValidator } from './validation/event-validator';

// Views
export { ViewMaterializer } from './views/view-materializer';

// Identifier utilities
export type { IdentifierConfig } from './types';
export {
  toResourceUri,
  toAnnotationUri,
  generateAnnotationId,
} from './identifier-utils';
