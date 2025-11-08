/**
 * ProjectionManager - Projection Management Layer
 *
 * Single Responsibility: Projection updates only
 * - Updates resource projections from events
 * - Updates system projections (entity types)
 * - Rebuilds projections when needed
 *
 * Does NOT handle:
 * - Event persistence (see EventLog)
 * - Pub/sub notifications (see EventBus)
 */

import { type ResourceId, type ResourceEvent, type StoredEvent } from '@semiont/core';
import { EventProjector, type ProjectorConfig } from './projections/event-projector';
import type { ProjectionStorage, ResourceState } from '../storage/projection-storage';

export interface ProjectionManagerConfig {
  basePath: string;
  backendUrl: string;
}

/**
 * ProjectionManager wraps EventProjector with a clean API
 * Handles both resource and system-level projections
 */
export class ProjectionManager {
  // Expose projector for direct access to projection methods
  readonly projector: EventProjector;

  constructor(
    projectionStorage: ProjectionStorage,
    config: ProjectionManagerConfig
  ) {
    const projectorConfig: ProjectorConfig = {
      basePath: config.basePath,
      backendUrl: config.backendUrl,
    };
    this.projector = new EventProjector(projectionStorage, projectorConfig);
  }

  /**
   * Update resource projection with a new event
   * Falls back to full rebuild if projection doesn't exist
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param event - Resource event (from @semiont/core)
   * @param getAllEvents - Function to retrieve all events for rebuild if needed
   */
  async updateResourceProjection(
    resourceId: ResourceId,
    event: ResourceEvent,
    getAllEvents: () => Promise<StoredEvent[]>
  ): Promise<void> {
    await this.projector.updateProjectionIncremental(resourceId, event, getAllEvents);
  }

  /**
   * Update system-level projection (currently only entity types)
   * @param eventType - Type of system event
   * @param payload - Event payload
   */
  async updateSystemProjection(eventType: string, payload: any): Promise<void> {
    if (eventType === 'entitytype.added') {
      await this.projector.updateEntityTypesProjection(payload.entityType);
    }
    // Future system projections can be added here
    // e.g., user.created, workspace.created, etc.
  }

  /**
   * Get resource projection (builds from events if needed)
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param events - Stored events for the resource (from @semiont/core)
   * @returns Resource state projection or null if no events
   */
  async getResourceProjection(
    resourceId: ResourceId,
    events: StoredEvent[]
  ): Promise<ResourceState | null> {
    return this.projector.projectResource(events, resourceId);
  }
}
