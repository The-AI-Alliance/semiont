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

import { type ResourceId, type PersistedEvent, type StoredEvent, type Logger, serializePerKey } from '@semiont/core';
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
 * ViewManager serializes these via `serializePerKey` from `@semiont/core`:
 * each incoming `materializeResource` call chains onto the previous one
 * for the same `resourceId`, so the work runs strictly sequentially per
 * resource while still parallelizing across different resources. System
 * events go through their own shared chain (keyed by a sentinel).
 *
 * Why this shape and not RxJS `groupBy + concatMap`:
 * ViewManager is called **synchronously** by `EventStore.appendEvent` — it
 * must block the caller until the view is written, so SSE subscribers
 * that see the subsequently-published event get the up-to-date view (a
 * read-your-writes guarantee). The RxJS stream-consumer pattern used by
 * `Smelter`, `GraphDBConsumer`, and `Gatherer` can't provide that
 * guarantee because it's fire-and-forget from the publisher's perspective.
 * Both patterns solve "serialize work per resource" — see also
 * `packages/core/src/serialize-per-key.ts` for the shared primitive.
 */
export class ViewManager {
  // Expose materializer for direct access to view methods
  readonly materializer: ViewMaterializer;

  // Per-resource write serialization. Keyed by the string form of ResourceId;
  // values are promise tails in the in-flight chain for each resource.
  // Entries are removed once the chain empties — see `serializePerKey`.
  private resourceChains = new Map<string, Promise<void>>();

  // Shared chain for system-level views (entity types, etc.). A single
  // sentinel key serializes all system-level writes; these events are
  // rare and global, so per-type keying buys nothing.
  private systemChains = new Map<symbol, Promise<void>>();
  private static readonly SYSTEM_KEY = Symbol('system');

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
    await serializePerKey(String(resourceId), this.resourceChains, () =>
      this.materializer.materializeIncremental(resourceId, event, getAllEvents),
    );
  }

  /**
   * Update system-level view (currently only entity types).
   * Serialized through a shared chain — see class doc.
   */
  async materializeSystem(eventType: string, payload: any): Promise<void> {
    await serializePerKey(ViewManager.SYSTEM_KEY, this.systemChains, async () => {
      if (eventType === 'mark:entity-type-added') {
        await this.materializer.materializeEntityTypes(payload.entityType);
      }
      // Future system views can be added here
    });
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
