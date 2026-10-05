/**
 * Entity Types Bootstrap
 *
 * On startup, seeds the KB with DEFAULT_ENTITY_TYPES by emitting
 * frame:add-entity-type for each missing type. Reads the __system__ event
 * stream (the durable source of truth in .semiont/events/) to determine
 * which types already exist.
 *
 * Idempotent: safe to call on every startup. Only emits events for types
 * not already in the log.
 *
 * No sentinel event records that first-time init completed, and none records
 * a schema upgrade: scanning the small __system__ stream on every startup is
 * simple and correct.
 */

import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { EventBus, userId, kbDid, busRequest, SYSTEM_SCOPE, type Logger } from '@semiont/core';
import { asBusRequestPrimitive } from '../bus-request-local';
import type { EventStore } from '@semiont/event-sourcing';

/**
 * Bootstrap entity types if any are missing from the event log.
 * Reads the __system__ stream to find existing frame:entity-type-added events,
 * then emits only the missing ones, as the knowledge base itself: `kbDomain`
 * is its committed `[site] domain`.
 */
export async function bootstrapEntityTypes(eventBus: EventBus, eventStore: EventStore, kbDomain: string, logger?: Logger): Promise<void> {
  // Read the __system__ event stream — the durable source of truth
  const systemEvents = await eventStore.log.getEvents(SYSTEM_SCOPE);
  const existingTypes = new Set(
    systemEvents
      .filter(e => e.type === 'frame:entity-type-added')
      .map(e => (e.payload as { entityType: string }).entityType)
  );

  const missing = DEFAULT_ENTITY_TYPES.filter(t => !existingTypes.has(t));

  if (missing.length === 0) {
    logger?.info('All entity types already in event log, skipping bootstrap', { count: existingTypes.size });
    return;
  }

  logger?.info('Bootstrapping missing entity types', { missing: missing.length, existing: existingTypes.size });

  // The knowledge base seeds its own defaults: the actor is neither a person
  // (`did:web:<domain>:users:…`) nor a software peer (`…:agents:…`), but the
  // knowledge base, under its own DID.
  const kbUserId = userId(kbDid(kbDomain));

  for (const entityType of missing) {
    logger?.debug('Adding entity type via EventBus', { entityType });

    // Confirmed request/reply over the in-process bus — the same path the SDK
    // uses. busRequest matches the correlation-keyed frame:entity-type-add-ok /
    // -failed reply and throws (BusRequestError) on failure or timeout.
    await busRequest(
      asBusRequestPrimitive(eventBus),
      'frame:add-entity-type',
      { tag: entityType, _userId: kbUserId },
      10_000,
    );
  }

  logger?.info('Entity types bootstrap completed', { added: missing.length, total: DEFAULT_ENTITY_TYPES.length });
}
