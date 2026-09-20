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
 * Future: evolve toward a migration-based model where a `system:bootstrapped`
 * sentinel event records that first-time init completed, and `system:migrated`
 * events record schema version upgrades (e.g., adding new default entity types
 * in a future release). For now, scanning the small __system__ stream is simple
 * and correct.
 */

import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { EventBus, userId, resourceId, busRequest, type Logger } from '@semiont/core';
import { asBusRequestPrimitive } from '../bus-request-local';
import type { EventStore } from '@semiont/event-sourcing';

/**
 * Bootstrap entity types if any are missing from the event log.
 * Reads the __system__ stream to find existing frame:entity-type-added events,
 * then emits only the missing ones.
 */
export async function bootstrapEntityTypes(eventBus: EventBus, eventStore: EventStore, logger?: Logger): Promise<void> {
  // Read the __system__ event stream — the durable source of truth
  const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
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

  // Semiont itself, seeding the defaults — not a person and not a software
  // peer, so neither `did:web:<domain>:users:…` nor `…:agents:…` fits, and no
  // domain is in scope here anyway. A method-specific DID says plainly which
  // actor this is.
  //
  // It replaces a nil UUID, which was a row id in the shape identities no
  // longer take. Event logs written before this keep that value on their
  // bootstrap events; `_userId` is an opaque string on the wire and nothing
  // parses it, so both read back fine.
  const SYSTEM_USER_ID = userId('did:semiont:system');

  for (const entityType of missing) {
    logger?.debug('Adding entity type via EventBus', { entityType });

    // Confirmed request/reply over the in-process bus — the same path the SDK
    // uses. busRequest matches the correlation-keyed frame:entity-type-add-ok /
    // -failed reply and throws (BusRequestError) on failure or timeout.
    await busRequest(
      asBusRequestPrimitive(eventBus),
      'frame:add-entity-type',
      { tag: entityType, _userId: SYSTEM_USER_ID },
      10_000,
    );
  }

  logger?.info('Entity types bootstrap completed', { added: missing.length, total: DEFAULT_ENTITY_TYPES.length });
}
