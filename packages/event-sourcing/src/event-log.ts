/**
 * EventLog - Event Persistence Layer
 *
 * Single Responsibility: Event persistence only
 * - Appends events to storage (JSONL files)
 * - Retrieves events by resource
 * - Queries events with filters
 *
 * Does NOT handle:
 * - Pub/sub notifications (see EventBus)
 * - View updates (see ViewManager)
 */

import { type ResourceId, type StoredEvent, type ResourceEvent, type EventQuery } from '@semiont/core';
import { EventStorage } from './storage/event-storage';

export interface EventLogConfig {
  basePath: string;
  dataDir: string;
  enableSharding?: boolean;
  maxEventsPerFile?: number;
}

export class EventLog {
  // Expose storage for EventQuery (read operations)
  readonly storage: EventStorage;

  constructor(config: EventLogConfig) {
    this.storage = new EventStorage({
      basePath: config.basePath,
      dataDir: config.dataDir,
      enableSharding: config.enableSharding ?? true,
      maxEventsPerFile: config.maxEventsPerFile ?? 10000,
    });
  }

  /**
   * Append event to log
   * @param event - Resource event (from @semiont/core)
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @returns Stored event with metadata (sequence number, timestamp, checksum)
   */
  async append(event: Omit<ResourceEvent, 'id' | 'timestamp'>, resourceId: ResourceId): Promise<StoredEvent> {
    return this.storage.appendEvent(event, resourceId);
  }

  /**
   * Get all events for a resource
   * @param resourceId - Branded ResourceId (from @semiont/core)
   */
  async getEvents(resourceId: ResourceId): Promise<StoredEvent[]> {
    return this.storage.getAllEvents(resourceId);
  }

  /**
   * Get all resource IDs
   * @returns Array of branded ResourceId types
   */
  async getAllResourceIds(): Promise<ResourceId[]> {
    return this.storage.getAllResourceIds();
  }

  /**
   * Query events with filter
   * @param resourceId - Branded ResourceId (from @semiont/core)
   * @param filter - Optional event filter
   */
  async queryEvents(resourceId: ResourceId, filter?: EventQuery): Promise<StoredEvent[]> {
    const events = await this.storage.getAllEvents(resourceId);
    if (!filter) return events;

    return events.filter(e => {
      if (filter.eventTypes && !filter.eventTypes.includes(e.event.type as any)) return false;
      if (filter.fromSequence && e.metadata.sequenceNumber < filter.fromSequence) return false;
      if (filter.fromTimestamp && e.event.timestamp < filter.fromTimestamp) return false;
      if (filter.toTimestamp && e.event.timestamp > filter.toTimestamp) return false;
      if (filter.userId && e.event.userId !== filter.userId) return false;
      return true;
    });
  }
}
