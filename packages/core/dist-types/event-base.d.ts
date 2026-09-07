/**
 * Event Base Types
 *
 * Core shapes for the event-sourced persistence model.
 * EventBase is the common shape for all domain events.
 * StoredEvent wraps an event with persistence metadata.
 *
 * These types are referenced by event-catalog.ts (domain events)
 * and bus-protocol.ts (the full EventMap).
 */
import type { components } from './types';
import type { ResourceId, UserId } from './identifiers';
import type { PersistedEvent } from './persisted-events';
/**
 * Narrow an OpenAPI-generated type by overriding specific fields with branded types.
 *
 * OpenAPI schemas use plain `string` for identifiers. TypeScript branded types
 * (ResourceId, AnnotationId, UserId, JobId) add compile-time safety. Brand<T, B>
 * takes the OpenAPI type T and replaces the fields listed in B with their branded
 * counterparts, preserving all other fields from the schema.
 *
 * @example
 * type MyCommand = Brand<components['schemas']['YieldCreateCommand'], { userId: UserId }>;
 * // Result: YieldCreateCommand with userId narrowed from string to UserId
 */
export type Brand<T, Overrides> = Omit<T, keyof Overrides> & Overrides;
/** Fields common to ALL domain events (system and resource-scoped). */
export interface EventBase {
    id: string;
    timestamp: string;
    resourceId?: ResourceId;
    userId: UserId;
    version: number;
}
/** Persistence metadata attached to every stored event. */
export type EventMetadata = components['schemas']['EventMetadata'];
/** Optional cryptographic signature on a stored event. */
export interface EventSignature {
    algorithm: 'ed25519';
    publicKey: string;
    signature: string;
    keyId?: string;
}
/**
 * A domain event with persistence metadata.
 * Flat intersection — no nesting (event.type, not event.event.type).
 */
export type StoredEvent<T extends EventBase = PersistedEvent> = T & {
    metadata: EventMetadata;
    signature?: EventSignature;
};
export type BodyItem = components['schemas']['TextualBody'] | components['schemas']['SpecificResource'];
export type BodyOperation = components['schemas']['BodyOperationAdd'] | components['schemas']['BodyOperationRemove'] | components['schemas']['BodyOperationReplace'];
import type { Annotation } from './annotation-types';
export interface EventQuery {
    resourceId?: ResourceId;
    userId?: string;
    eventTypes?: string[];
    fromTimestamp?: string;
    toTimestamp?: string;
    fromSequence?: number;
    limit?: number;
}
export interface ResourceAnnotations {
    resourceId: ResourceId;
    annotations: Annotation[];
    version: number;
    updatedAt: string;
}
