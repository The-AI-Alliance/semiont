/**
 * How `job:create` validation reads the KB's registered entity types and tag
 * schemas — over the bus, from the Archivist's Browser that owns those
 * projections (EXTRACT-JOBS D7).
 *
 * One implementation for every process, because every process holds a
 * `BusRequestPrimitive` that reaches the Browser: the in-process root's local
 * bus (the Browser is in-process) and the dispatcher's `HttpTransport` (SSE in,
 * `/bus/emit` out — the reply channels must be in its subscription set, which
 * `busRequest`'s probe enforces loudly at first use).
 *
 * This replaces the two `fs.readFile` reads off the shared `/semiont-state`
 * mount (`readEntityTypesProjection` / `readTagSchemasProjection`): the
 * dispatcher no longer mounts the KB's materialized views to validate a job —
 * it asks the service that owns them. D7: do not proliferate mounts.
 */
import { busRequest, type BusOperationKey, type BusRequestPrimitive, type TagSchema } from '@semiont/core';

/** The per-KB registries `job:create` validates against. */
export interface ProjectionReads {
  /** The KB's registered entity types (empty when none registered). */
  entityTypes(): Promise<string[]>;
  /** The KB's registered tag schemas (empty when none registered). */
  tagSchemas(): Promise<TagSchema[]>;
}

const ENTITY_TYPES_OPERATION = 'browse:entity-types-requested' satisfies BusOperationKey;
const TAG_SCHEMAS_OPERATION = 'browse:tag-schemas-requested' satisfies BusOperationKey;

/** The declared awaits (the service-channels census pattern): a transport
 *  carrying these reads must subscribe both operations' reply channels. */
export type ProjectionReadsAwaits =
  | typeof ENTITY_TYPES_OPERATION
  | typeof TAG_SCHEMAS_OPERATION;

export function projectionReadsOverBus(bus: BusRequestPrimitive): ProjectionReads {
  // `busRequest` unwraps the reply's `response` field, so these land as the
  // bare `{ entityTypes }` / `{ tagSchemas }` the Browser puts inside it.
  return {
    entityTypes: async () => (await busRequest(bus, ENTITY_TYPES_OPERATION, {})).entityTypes,
    tagSchemas: async () => (await busRequest(bus, TAG_SCHEMAS_OPERATION, {})).tagSchemas,
  };
}
