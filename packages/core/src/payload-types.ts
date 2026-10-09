/**
 * Payload Type Aliases
 *
 * Convenience aliases for OpenAPI-generated schema types that are
 * referenced across the codebase. Shorter than
 * `components['schemas']['<Name>']` and carry intent.
 *
 * These aliases are not about the bus. They live here so that
 * bus-protocol.ts can focus on channel-protocol concerns (EventMap,
 * CHANNEL_SCHEMAS, scope classification).
 */

import type { components } from './types';

export type Selector = components['schemas']['Selector'];

export type GatheredContext = components['schemas']['GatheredContext'];

/**
 * The wire's failure vocabulary, under the spec's own name. `CommandError.code`
 * is optional — absence means "no class declared" — so the alias drops the
 * `undefined` and names the members themselves, which is what a mapping keyed by
 * this union has to be total over.
 */
export type CommandErrorCode = NonNullable<components['schemas']['CommandError']['code']>;

// What a job is asked with and what it reports, under the spec's own names —
// the wire owns these shapes, and a differently-named local alias is a rename
// layer, not a derivation.
export type MarkJobParams = components['schemas']['MarkJobParams'];
export type JobFilter = components['schemas']['JobFilter'];
export type JobResult = components['schemas']['JobResult'];
export type JobDetectionResult = components['schemas']['JobDetectionResult'];
export type JobGenerationResult = components['schemas']['JobGenerationResult'];
/** What a `mark` job reports: its counts, or a decline. */
export type MarkJobResult = components['schemas']['MarkJobResult'];
/** What a `yield` job reports: the resource it made, or a decline. */
export type YieldJobResult = components['schemas']['YieldJobResult'];

/**
 * The furthest one unit of a job got, and what it had counted there: where a
 * resume takes an unfinished unit up, and where a finished unit ended.
 * Spec-owned: it crosses the wire on three job commands and is read back off
 * the claimed record's metadata, so the queue, the worker and the Go client
 * all have to mean the same `{ next, size }`.
 */
export type UnitCursor = components['schemas']['UnitCursor'];
/**
 * A `yield` job's parameters — one type shared by the write side (the SDK's
 * `yield.delegate`) and the read side (the worker's `isGenerationJobParams`
 * narrowing), so the two ends of the wire cannot drift a field apart silently.
 */
export type GenerationJobParams = components['schemas']['GenerationJobParams'];
export type SelectionData = components['schemas']['SelectionData'];
export type JobType = components['schemas']['JobType'];

/**
 * One entry of the collaborator directory (`browse:agents-result`): a typed
 * `Agent` plus, for software agents drawn from the KB's worker config, the
 * jobs it serves, each named as a claim names it. Persons and actor-role-only
 * agents omit `serves`.
 */
export type CollaboratorEntry = components['schemas']['CollaboratorEntry'];

/**
 * A directory entry with its model's discovered limits, as the SDK joins them:
 * the directory lists who serves each role, and the services holding the
 * inference credentials report the limits (`LIMITS_OPERATIONS`). Absent
 * `limits` means no key holder reported that model.
 */
export type Collaborator = CollaboratorEntry & { limits?: components['schemas']['InferenceLimits'] };

/**
 * What a knowledge base says of itself (`browse:kb-result`): its committed
 * name and domain, and the working tree's branch. The Archivist answers it;
 * it is the only source clients use for a KB's name and domain.
 */
export type KbDescription = components['schemas']['KbDescription'];

/**
 * The launcher's published KB-discovery view: the document at
 * `DISCOVERY_URL_PATH` and its entries. Endpoints and identity only — never
 * credentials.
 */
export type DiscoveryDocument = components['schemas']['DiscoveryDocument'];
export type DiscoveredKB = components['schemas']['DiscoveredKB'];
