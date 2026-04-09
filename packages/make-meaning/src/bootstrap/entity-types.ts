/**
 * Entity Types Bootstrap
 *
 * On startup, seeds the KB with DEFAULT_ENTITY_TYPES by emitting
 * mark:add-entity-type for each missing type. Reads the __system__ event
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
import { EventBus, userId, resourceId, type Logger } from '@semiont/core';
import type { EventStore } from '@semiont/event-sourcing';
import { firstValueFrom, race, timer } from 'rxjs';
import { map, take } from 'rxjs/operators';

/**
 * Bootstrap entity types if any are missing from the event log.
 * Reads the __system__ stream to find existing mark:entity-type-added events,
 * then emits only the missing ones.
 */
export async function bootstrapEntityTypes(eventBus: EventBus, eventStore: EventStore, logger?: Logger): Promise<void> {
  // Read the __system__ event stream — the durable source of truth
  const systemEvents = await eventStore.log.getEvents(resourceId('__system__'));
  const existingTypes = new Set(
    systemEvents
      .filter(e => e.type === 'mark:entity-type-added')
      .map(e => (e.payload as { entityType: string }).entityType)
  );

  const missing = DEFAULT_ENTITY_TYPES.filter(t => !existingTypes.has(t));

  if (missing.length === 0) {
    logger?.info('All entity types already in event log, skipping bootstrap', { count: existingTypes.size });
    return;
  }

  logger?.info('Bootstrapping missing entity types', { missing: missing.length, existing: existingTypes.size });

  const SYSTEM_USER_ID = userId('00000000-0000-0000-0000-000000000000');

  for (const entityType of missing) {
    logger?.debug('Adding entity type via EventBus', { entityType });

    const result$ = race(
      eventBus.get('mark:entity-type-added').pipe(take(1), map(() => ({ ok: true as const }))),
      eventBus.get('mark:entity-type-add-failed').pipe(take(1), map((f) => ({ ok: false as const, error: new Error(f.message) }))),
      timer(10_000).pipe(map(() => ({ ok: false as const, error: new Error(`Timeout adding entity type: ${entityType}`) }))),
    );

    eventBus.get('mark:add-entity-type').next({ tag: entityType, userId: SYSTEM_USER_ID });

    const outcome = await firstValueFrom(result$);
    if (!outcome.ok) {
      throw outcome.error;
    }
  }

  logger?.info('Entity types bootstrap completed', { added: missing.length, total: DEFAULT_ENTITY_TYPES.length });
}
