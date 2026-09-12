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

export type Selector =
  | components['schemas']['TextPositionSelector']
  | components['schemas']['TextQuoteSelector']
  | components['schemas']['SvgSelector']
  | components['schemas']['FragmentSelector'];

export type GatheredContext = components['schemas']['GatheredContext'];

// Detection job results, under the spec's own names — the wire owns these
// shapes, and a differently-named local alias is a rename layer, not a
// derivation.
export type JobReferenceAnnotationResult = components['schemas']['JobReferenceAnnotationResult'];
export type JobHighlightAnnotationResult = components['schemas']['JobHighlightAnnotationResult'];
export type JobCommentAnnotationResult = components['schemas']['JobCommentAnnotationResult'];
export type JobAssessmentAnnotationResult = components['schemas']['JobAssessmentAnnotationResult'];
export type JobTagAnnotationResult = components['schemas']['JobTagAnnotationResult'];

/**
 * How far one unit of a job got, for a resume that starts mid-unit
 * (CHUNK-GRAIN-RESUME P2). Spec-owned: it crosses the wire on three job
 * commands and is read back off the claimed record's metadata, so the queue,
 * the worker and the Go client all have to mean the same `{ next, size }`.
 */
export type UnitCursor = components['schemas']['UnitCursor'];
/**
 * The `job:create` params shape for `jobType: 'generation'` — one type shared
 * by the write side (sdk `yield.fromContext` → `runGeneration`) and the read
 * side (the generation worker's `isGenerationJobParams` narrowing), so the two
 * ends of the wire cannot drift a field apart silently.
 */
export type GenerationJobParams = components['schemas']['GenerationJobParams'];
export type SelectionData = components['schemas']['SelectionData'];
export type JobType = components['schemas']['JobType'];

/**
 * One entry of the collaborator directory (`browse:agents-result`): a typed
 * `Agent` plus, for software agents drawn from the KB's worker config, the
 * job types it serves. Persons and actor-role-only agents omit
 * `servesJobTypes`. See .plans/COLLABORATOR-DIRECTORY.md.
 */
export type CollaboratorEntry = components['schemas']['CollaboratorEntry'];

/**
 * The launcher's published KB-discovery view (BROWSER-KB-DISCOVERY): the
 * document at `DISCOVERY_URL_PATH` and its entries. Endpoints and identity
 * only — never credentials.
 */
export type DiscoveryDocument = components['schemas']['DiscoveryDocument'];
export type DiscoveredKB = components['schemas']['DiscoveredKB'];
