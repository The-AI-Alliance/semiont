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

import { type ResourceId, type ResourceEvent, type StoredEvent } from '@semiont/core';
import { ViewMaterializer, type ViewMaterializerConfig } from './views/view-materializer';
import type { ViewStorage, ResourceView } from '../storage/view-storage';

export interface ViewManagerConfig {
  basePath: string;
  backendUrl: string;
}

/**
 * ViewManager wraps ViewMaterializer with a clean API
 * Handles both resource and system-level views
 */
export class ViewManager {
  // Expose materializer for direct access to view methods
  readonly materializer: ViewMaterializer;

  constructor(
    projectionStorage: ViewStorage,
    config: ViewManagerConfig
  ) {
    const materializerConfig: ViewMaterializerConfig = {
      basePath: config.basePath,
      backendUrl: config.backendUrl,
    };
    this.materializer = new ViewMaterializer(projectionStorage, materializerConfig);
  }

  /**
   * Update resource view with a new event
   * Falls back to full rebuild if view doesn't exist
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param event - Resource event (from @semiont/core)
   * @param getAllEvents - Function to retrieve all events for rebuild if needed
   */
  async materializeResource(
    resourceId: ResourceId,
    event: ResourceEvent,
    getAllEvents: () => Promise<StoredEvent[]>
  ): Promise<void> {
    await this.materializer.materializeIncremental(resourceId, event, getAllEvents);
  }

  /**
   * Update system-level view (currently only entity types)
   * @param eventType - Type of system event
   * @param payload - Event payload
   */
  async materializeSystem(eventType: string, payload: any): Promise<void> {
    if (eventType === 'entitytype.added') {
      await this.materializer.materializeEntityTypes(payload.entityType);
    }
    // Future system views can be added here
    // e.g., user.created, workspace.created, etc.
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
