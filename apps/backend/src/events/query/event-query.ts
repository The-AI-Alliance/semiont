/**
 * Event Query - Read Operations
 *
 * Handles querying and reading events from storage:
 * - Query events with filters (type, user, timestamp, sequence)
 * - Get all events for a document
 * - Get last event from a file
 * - Efficient streaming reads from JSONL files
 *
 * @see docs/EVENT-STORE.md#eventquery for architecture details
 */

import type { StoredEvent, EventQuery as EventQueryType } from '@semiont/core';
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
    if (!query.documentId) {
      throw new Error('documentId is required for event queries');
    }

    // Get all events from storage
    const allEvents = await this.eventStorage.getAllEvents(query.documentId);

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
   * Get all events for a specific document (no filters)
   */
  async getDocumentEvents(documentId: string): Promise<StoredEvent[]> {
    return this.eventStorage.getAllEvents(documentId);
  }

  /**
   * Get the last event from a specific file
   * Useful for initializing sequence numbers and last hashes
   */
  async getLastEvent(documentId: string, filename: string): Promise<StoredEvent | null> {
    return this.eventStorage.getLastEvent(documentId, filename);
  }

  /**
   * Get the latest event for a document across all files
   */
  async getLatestEvent(documentId: string): Promise<StoredEvent | null> {
    const files = await this.eventStorage.getEventFiles(documentId);
    if (files.length === 0) return null;

    // Check files in reverse order (newest first)
    for (let i = files.length - 1; i >= 0; i--) {
      const file = files[i];
      if (!file) continue;
      const lastEvent = await this.eventStorage.getLastEvent(documentId, file);
      if (lastEvent) return lastEvent;
    }

    return null;
  }

  /**
   * Get event count for a document
   */
  async getEventCount(documentId: string): Promise<number> {
    const events = await this.getDocumentEvents(documentId);
    return events.length;
  }

  /**
   * Check if a document has any events
   */
  async hasEvents(documentId: string): Promise<boolean> {
    const files = await this.eventStorage.getEventFiles(documentId);
    return files.length > 0;
  }
}
