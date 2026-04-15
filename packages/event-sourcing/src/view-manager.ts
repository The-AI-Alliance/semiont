/**
 * ViewManager - Materialized View Management Layer
 *
 * Single Responsibility: View updates only
 * - Updates resource views from events
 * - Updates system views (entity types)
 * - Rebuilds views when needed
 *
 * Does NOT handle:
 * - Event persistence (see EventLog)
 * - Pub/sub notifications (see EventBus)
 */

import { type ResourceId, type PersistedEvent, type StoredEvent, type Logger } from '@semiont/core';
import { ViewMaterializer, type ViewMaterializerConfig, type RebuildEventSource } from './views/view-materializer';
import type { ViewStorage, ResourceView } from './storage/view-storage';

export interface ViewManagerConfig {
  basePath: string;
}

/**
 * ViewManager wraps ViewMaterializer with a clean API
 * Handles both resource and system-level views
 *
 * ## Per-resource serialization
 *
 * `materializeResource` runs read-modify-write cycles on the view file for
 * a given resource (load JSON → apply event → save JSON). When multiple
 * events arrive for the same resource in rapid succession — the canonical
 * example is the reference-detection worker emitting `mark:added` +
 * `job:progress` + `job:completed` within a few milliseconds — concurrent
 * RMW cycles will clobber each other, losing events and occasionally
 * corrupting the view file entirely.
 *
 * ViewManager serializes these by maintaining a per-resource promise chain:
 * each incoming `materializeResource` call chains onto the previous one
 * for the same `resourceId`, so the work runs strictly sequentially per
 * resource while still parallelizing across different resources. System
 * events go through their own shared chain.
 *
 * Error isolation: a rejected chain does not poison subsequent events —
 * `.catch(() => {})` in the link ensures the next event starts fresh from
 * whatever state the failed operation left on disk.
 */
export class ViewManager {
  // Expose materializer for direct access to view methods
  readonly materializer: ViewMaterializer;

  // Per-resource write serialization. Key is the string form of ResourceId;
  // value is a promise representing the tail of the in-flight chain for that
  // resource. Entries are removed once the chain empties.
  private resourceChains = new Map<string, Promise<void>>();

  // Shared chain for system-level views (entity types, etc.). Single chain
  // is fine — system events are rare and global.
  private systemChain: Promise<void> = Promise.resolve();

  constructor(
    viewStorage: ViewStorage,
    config: ViewManagerConfig,
    logger?: Logger
  ) {
    const materializerConfig: ViewMaterializerConfig = {
      basePath: config.basePath,
    };
    this.materializer = new ViewMaterializer(viewStorage, materializerConfig, logger?.child({ component: 'ViewMaterializer' }));
  }

  /**
   * Update resource view with a new event.
   * Serialized per resource — see class doc.
   *
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param event - Resource event (from @semiont/core)
   * @param getAllEvents - Function to retrieve all events for rebuild if needed
   */
  async materializeResource(
    resourceId: ResourceId,
    event: PersistedEvent,
    getAllEvents: () => Promise<StoredEvent[]>
  ): Promise<void> {
    const key = String(resourceId);
    const prev = this.resourceChains.get(key) ?? Promise.resolve();

    // Chain onto prev, swallowing any error from the previous link so one
    // bad event doesn't poison subsequent ones. The new link's own errors
    // still propagate to our caller via the final `await next`.
    const next = prev
      .catch(() => { /* prior failure doesn't block us */ })
      .then(() => this.materializer.materializeIncremental(resourceId, event, getAllEvents));

    this.resourceChains.set(key, next);

    try {
      await next;
    } finally {
      // Only clear the entry if we're still the tail. If another caller
      // has already chained onto us, leave it so the chain stays intact.
      if (this.resourceChains.get(key) === next) {
        this.resourceChains.delete(key);
      }
    }
  }

  /**
   * Update system-level view (currently only entity types).
   * Serialized through a shared chain — see class doc.
   */
  async materializeSystem(eventType: string, payload: any): Promise<void> {
    const next = this.systemChain
      .catch(() => { /* prior failure doesn't block us */ })
      .then(async () => {
        if (eventType === 'mark:entity-type-added') {
          await this.materializer.materializeEntityTypes(payload.entityType);
        }
        // Future system views can be added here
      });

    this.systemChain = next;
    await next;
  }

  /**
   * Rebuild all materialized views from the event log on startup.
   * Mirrors GraphDBConsumer.rebuildAll() — call this once during
   * createKnowledgeBase before the HTTP server begins accepting requests.
   * Idempotent: existing view files are overwritten.
   */
  async rebuildAll(eventLog: RebuildEventSource): Promise<void> {
    return this.materializer.rebuildAll(eventLog);
  }

  /**
   * Get resource view (builds from events if needed)
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param events - Stored events for the resource (from @semiont/core)
   * @returns Resource view or null if no events
   */
  async getOrMaterialize(
    resourceId: ResourceId,
    events: StoredEvent[]
  ): Promise<ResourceView | null> {
    return this.materializer.materialize(events, resourceId);
  }
}
