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
export type MarkJobDone = components['schemas']['MarkJobDone'];
export type YieldJobDone = components['schemas']['YieldJobDone'];
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
 * A `yield` job's parameters, as the spec states them: what the SDK's
 * `yield.delegate` writes and what a worker is handed with the job.
 */
export type GenerationJobParams = components['schemas']['GenerationJobParams'];
export type JobType = components['schemas']['JobType'];

/**
 * One of the knowledge base's engines (`browse:engines-result`): a provider and
 * a model its Inference document names, and the jobs the document has it used
 * for, each named as a claim names it. An engine only Librarian actors ask
 * omits `jobs`. An engine is not a principal: it carries no identity of its own.
 */
export type EngineEntry = components['schemas']['EngineEntry'];

/**
 * An engine with the inference limits its key holder reported, as the SDK
 * joins them: the knowledge base names its engines, and the services holding
 * the inference credentials report the limits (`LIMITS_OPERATIONS`). Absent
 * `limits` means no key holder reported that engine.
 */
export type EngineWithLimits = EngineEntry & { limits?: components['schemas']['InferenceLimits'] };

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

/**
 * A knowledge base as a client names it, kept locally and never sent: where to
 * connect (`KbTarget`, reached by its `KbEndpoint`), what registering one
 * takes (`NewKnowledgeBase`), and a registered one, which has said what it is
 * (`KnowledgeBase`, with its `KbRead`).
 */
export type KbTarget = components['schemas']['KbTarget'];
export type KnowledgeBase = components['schemas']['KnowledgeBase'];
export type NewKnowledgeBase = components['schemas']['NewKnowledgeBase'];
export type KbRead = components['schemas']['KbRead'];
export type KbEndpoint = components['schemas']['KbEndpoint'];
export type HttpEndpoint = components['schemas']['HttpEndpoint'];
export type LocalEndpoint = components['schemas']['LocalEndpoint'];
