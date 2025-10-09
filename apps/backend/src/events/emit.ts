/**
 * Event Emission Helpers
 *
 * Helper functions to emit events from CRUD operations
 * These bridge the current UUID-based system with the future content-addressed system
 */

import { getEventStore } from './event-store';
import type { StoredEvent } from '@semiont/core-types';

/**
 * Emit a document.created event
 */
export async function emitDocumentCreated(params: {
  documentId: string;
  userId: string;
  name: string;
  contentType: string;
  contentHash: string;
  entityTypes?: string[];
  metadata?: Record<string, any>;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  console.log('[emitDocumentCreated] Received metadata:', params.metadata);

  const event = {
    type: 'document.created' as const,
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      name: params.name,
      contentType: params.contentType,
      contentHash: params.contentHash,
      entityTypes: params.entityTypes,
      metadata: params.metadata,
    },
  };

  console.log('[emitDocumentCreated] Event payload.metadata:', event.payload.metadata);

  return eventStore.appendEvent(event);
}

/**
 * Emit a document.cloned event
 */
export async function emitDocumentCloned(params: {
  documentId: string;
  userId: string;
  name: string;
  contentType: string;
  contentHash: string;
  parentDocumentId: string;
  entityTypes?: string[];
  metadata?: Record<string, any>;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'document.cloned',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      name: params.name,
      contentType: params.contentType,
      contentHash: params.contentHash,
      parentDocumentId: params.parentDocumentId,
      entityTypes: params.entityTypes,
      metadata: params.metadata,
    },
  });
}

/**
 * Emit a document.archived event
 */
export async function emitDocumentArchived(params: {
  documentId: string;
  userId: string;
  reason?: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'document.archived',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      reason: params.reason,
    },
  });
}

/**
 * Emit a document.unarchived event
 */
export async function emitDocumentUnarchived(params: {
  documentId: string;
  userId: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'document.unarchived',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {},
  });
}

/**
 * Emit a highlight.added event
 */
export async function emitHighlightAdded(params: {
  documentId: string;
  userId: string;
  highlightId: string;
  exact: string;
  position: { offset: number; length: number };
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'highlight.added',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      highlightId: params.highlightId,
      exact: params.exact,
      position: params.position,
    },
  });
}

/**
 * Emit a highlight.removed event
 */
export async function emitHighlightRemoved(params: {
  documentId: string;
  userId: string;
  highlightId: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'highlight.removed',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      highlightId: params.highlightId,
    },
  });
}

/**
 * Emit a reference.created event
 */
export async function emitReferenceCreated(params: {
  documentId: string;
  userId: string;
  referenceId: string;
  exact: string;
  position: { offset: number; length: number };
  entityTypes?: string[];
  targetDocumentId?: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'reference.created',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      referenceId: params.referenceId,
      exact: params.exact,
      position: params.position,
      entityTypes: params.entityTypes,
      targetDocumentId: params.targetDocumentId,
    },
  });
}

/**
 * Emit a reference.resolved event
 */
export async function emitReferenceResolved(params: {
  documentId: string;
  userId: string;
  referenceId: string;
  targetDocumentId: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'reference.resolved',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      referenceId: params.referenceId,
      targetDocumentId: params.targetDocumentId,
    },
  });
}

/**
 * Emit a reference.deleted event
 */
export async function emitReferenceDeleted(params: {
  documentId: string;
  userId: string;
  referenceId: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'reference.deleted',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      referenceId: params.referenceId,
    },
  });
}

/**
 * Emit an entitytag.added event
 */
export async function emitEntityTagAdded(params: {
  documentId: string;
  userId: string;
  entityType: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'entitytag.added',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      entityType: params.entityType,
    },
  });
}

/**
 * Emit an entitytag.removed event
 */
export async function emitEntityTagRemoved(params: {
  documentId: string;
  userId: string;
  entityType: string;
}): Promise<StoredEvent> {
  const eventStore = await getEventStore();

  return eventStore.appendEvent({
    type: 'entitytag.removed',
    documentId: params.documentId,
    userId: params.userId,
    version: 1,
    payload: {
      entityType: params.entityType,
    },
  });
}