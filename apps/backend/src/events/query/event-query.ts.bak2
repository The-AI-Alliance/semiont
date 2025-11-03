/**
 * Event Query - Read Operations
 *
 * Handles querying and reading events from storage:
 * - Query events with filters (type, user, timestamp, sequence)
 * - Get all events for a resource
 * - Get last event from a file
 * - Efficient streaming reads from JSONL files
 *
 * @see docs/EVENT-STORE.md#eventquery for architecture details
 */

import type { StoredEvent, EventQuery as EventQueryType } from '@semiont/core';
import { resourceId, userId, annotationId } from '@semiont/core';
import type { EventStorage } from '../storage/event-storage';

/**
 * EventQuery handles all read operations for events
 * Uses EventStorage for file access, adds query filtering
 */
export class EventQuery {
  constructor(private eventStorage: EventStorage) {}

  /**
   * Query events with filters
   * Supports filtering by: userId, eventTypes, timestamps, sequence number, limit
   */
  async queryEvents(query: EventQueryType): Promise<StoredEvent[]> {
    if (!query.resourceId) {
      throw new Error('resourceId is required for event queries');
    }

    // Get all events from storage
    const allEvents = await this.eventStorage.getAllEvents(query.resourceId);

    // Apply filters
    let results = allEvents;

    if (query.userId) {
      results = results.filter(e => e.event.userId === query.userId);
    }

    if (query.eventTypes && query.eventTypes.length > 0) {
      results = results.filter(e => query.eventTypes!.includes(e.event.type));
    }

    if (query.fromTimestamp) {
      results = results.filter(e => e.event.timestamp >= query.fromTimestamp!);
    }

    if (query.toTimestamp) {
      results = results.filter(e => e.event.timestamp <= query.toTimestamp!);
    }

    if (query.fromSequence) {
      results = results.filter(e => e.metadata.sequenceNumber >= query.fromSequence!);
    }

    // Apply limit
    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * Get all events for a specific resource (no filters)
   */
  async getResourceEvents(resourceId: string): Promise<StoredEvent[]> {
    return this.eventStorage.getAllEvents(resourceId);
  }

  /**
   * Get the last event from a specific file
   * Useful for initializing sequence numbers and last hashes
   */
  async getLastEvent(resourceId: string, filename: string): Promise<StoredEvent | null> {
    return this.eventStorage.getLastEvent(resourceId, filename);
  }

  /**
   * Get the latest event for a resource across all files
   */
  async getLatestEvent(resourceId: string): Promise<StoredEvent | null> {
    const files = await this.eventStorage.getEventFiles(resourceId);
    if (files.length === 0) return null;

    // Check files in reverse order (newest first)
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i];
      if (!file) continue;
      const lastEvent = await this.eventStorage.getLastEvent(resourceId, file);
      if (lastEvent) return lastEvent;
    }

    return null;
  }

  /**
   * Get event count for a resource
   */
  async getEventCount(resourceId: string): Promise<number> {
    const events = await this.getResourceEvents(resourceId);
    return events.length;
  }

  /**
   * Check if a resource has any events
   */
  async hasEvents(resourceId: string): Promise<boolean> {
    const files = await this.eventStorage.getEventFiles(resourceId);
    return files.length > 0;
  }
}
