/**
 * Verb Namespace Interfaces
 *
 * These interfaces define the public API of `@semiont/sdk`, organized by
 * the eight flows (Browse, Mark, Bind, Gather, Match, Yield, Beckon, Frame)
 * plus the `job`, `auth` and `system` namespaces.
 *
 * Each flow has one namespace. The frontend calls
 * `client.mark.annotation()` and the client handles HTTP, auth, SSE, and
 * caching internally.
 *
 * Return type conventions:
 * - Browse live queries → `CacheObservable<T>` (bus-driven, cached;
 *   subscribe yields `CacheState<T>`, `.fresh()` is the one-shot read)
 * - Browse one-shot reads → `Promise<T>` (fetch once, no cache)
 * - Commands (mark, bind, frame) and gather.resource → `Promise<T>`
 *   (resolve on the reply, reject on failure)
 * - Upload (yield.resource) → `UploadObservable` (the upload's phases;
 *   await yields `{ resourceId }`)
 * - Long-running ops (gather.annotation, match.search) →
 *   `StreamObservable<T>` (subscribe yields every emit, await yields the
 *   last one)
 * - Delegated jobs (mark.delegate, yield.delegate) → `DelegationObservable`
 *   (subscribe yields the job's events; await yields its completion)
 * - Ephemeral signals, local (beckon.hover/sparkle, browse.click, …) → `void`
 * - Wire drives at other participants (beckon.attention/click/openResource/
 *   sparkleAll) → `Promise<number | undefined>`: the /bus/emit subscriber
 *   count, absent when the gateway cannot count — information, not an ack
 *   (X5's third shape)
 *
 * `StreamObservable`, `DelegationObservable` and `UploadObservable` are
 * `Observable` subclasses that also implement `PromiseLike` — `await
 * client.X.Y(...)` works directly without a `lastValueFrom` wrapper.
 * `CacheObservable` is deliberately not thenable.
 * `.pipe(...)` returns a plain `Observable<T>` (the thenable subclass
 * does not propagate through pipe — by design).
 */

import type { Observable } from 'rxjs';
import type {
  StreamObservable,
  CacheObservable,
  DelegationObservable,
  MarkJobCompletion,
  UploadObservable,
  YieldJobCompletion,
} from '../awaitable';
import type { components, EventMap, paths } from '@semiont/core';
import type {
  ResourceId,
  AnnotationId,
  AttributedEvent,
  BodyOperation,
  GenerationJobParams,
  JobId,
  JobType,
  MarkJobParams,
  Motivation,
  AnchorRect,
  GatheredContext,
  TagSchema,
  Collaborator,
  KbDescription,
} from '@semiont/core';

// ── OpenAPI schema type aliases ─────────────────────────────────────────────

import type { Annotation } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
type GetResourceResponse = components['schemas']['GetResourceResponse'];
type MatchSearchResult = components['schemas']['MatchSearchResult'];
export type GatherAnnotationComplete = components['schemas']['GatherAnnotationComplete'];
type JobStatusResponse = components['schemas']['JobStatusResponse'];
type CloneResourceWithTokenResponse = components['schemas']['CloneResourceWithTokenResponse'];
type ProtectedResourceMetadata = components['schemas']['ProtectedResourceMetadata'];

// ── Response type helpers (extract JSON body from OpenAPI path types) ────────

export type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } }
  ? R
  : T extends { responses: { 201: { content: { 'application/json': infer R } } } }
    ? R
    : T extends { responses: { 202: { content: { 'application/json': infer R } } } }
      ? R
      : never;

export type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

// ── Domain-specific input types ─────────────────────────────────────────────

/** Input for creating an annotation via mark.annotation() */
export type CreateAnnotationInput = components['schemas']['CreateAnnotationRequest'];

/** Input for creating a resource via yield.resource() */
export interface CreateResourceInput {
  name: string;
  file: File | Buffer;
  format: string;
  entityTypes?: string[];
  language?: string;
  sourceAnnotationId?: string;
  sourceResourceId?: string;
  storageUri: string;
  /** Prompt that drove AI generation (for AI-generated resources). */
  generationPrompt?: string;
  /** Agent(s) that generated the content (for AI-generated resources). */
  generator?: components['schemas']['Agent'] | components['schemas']['Agent'][];
  /**
   * The job this resource fulfils. A worker sets it from the job it holds;
   * self-initiated creation leaves it absent. Who requested the resource is
   * derived by the knowledge base from the cited job's events — this input
   * never names a requester.
   */
  jobId?: string;
  isDraft?: boolean;
}

/** Options for yield.createFromToken() */
export type CreateFromTokenOptions = { token: string; name: string; content: string; archiveOriginal?: boolean };

/** Referenced-by entry from gather.referencedBy() */
export type ReferencedByEntry = components['schemas']['GetReferencedByResponse']['referencedBy'][number];

/** Annotation history from browse.annotationHistory() */
export type AnnotationHistoryResponse = components['schemas']['GetAnnotationHistoryResponse'];

/** The signed-in user, as `GET /api/users/me` returns it. */
export type User = components['schemas']['UserResponse'];

// ── Progress types for long-running Observable operations ───────────────────
//
// `gather.annotation()` emits exactly one value: the assembled context. No
// gather progress channel exists, so it has no progress type.

/**
 * What the match.search() Observable emits: the final MatchSearchResult.
 * There are no intermediate progress events.
 */
export type MatchSearchProgress = MatchSearchResult;

// ── Namespace interfaces ────────────────────────────────────────────────────

/**
 * What `browse.resources()` emits: the list-reply envelope, the page of
 * descriptors with the size of the whole listing.
 */
export type ResourceList = Omit<components['schemas']['ListResourcesResponse'], 'resources'> & {
  resources: ResourceDescriptor[];
};

/** The filters a text search takes beside its text. */
export type ResourceSearchFilters = { limit?: number; archived?: boolean; entityType?: string };

/**
 * What `match.resources()` emits: the search-reply envelope, not just the
 * page of descriptors. `matchKind` labels how the answer was produced —
 * `'lexical'` (title/metadata matching) or `'semantic'` (the empty-lexical
 * vector fallback) — and it arrives WITH the resources it describes as one
 * value, so a consumer can never pair the label with a different query's
 * list.
 */
export type MatchedResources = Omit<components['schemas']['MatchResourcesResponse'], 'resources'> & {
  resources: ResourceDescriptor[];
};

/**
 * Browse — reads from materialized views
 *
 * Live queries return Observables that emit initial state and re-emit
 * on bus gateway updates. One-shot reads return Promises.
 *
 * Gateway actor: Browser (context classes)
 * Event prefix: browse:*
 */
export interface BrowseNamespace {
  // Live queries (Observable — bus gateway driven, cached in BehaviorSubject)
  resource(resourceId: ResourceId): CacheObservable<ResourceDescriptor>;
  resources(filters?: { limit?: number; archived?: boolean; entityType?: string }): CacheObservable<ResourceList>;
  annotations(resourceId: ResourceId): CacheObservable<Annotation[]>;
  annotation(resourceId: ResourceId, annotationId: AnnotationId): CacheObservable<Annotation>;
  entityTypes(): CacheObservable<string[]>;
  tagSchemas(): CacheObservable<TagSchema[]>;
  /**
   * The KB's collaborator directory — declared software agents (with
   * `servesJobTypes` capabilities), not its members (Persons) —
   * with each model's limits as the services holding its inference
   * credentials report them. KB-wide singleton; cached for the client
   * lifetime, asked again when the stream reopens after a drop.
   */
  agents(): CacheObservable<Collaborator[]>;
  events(resourceId: ResourceId): CacheObservable<AttributedEvent[]>;

  // One-shot reads (Promise — no caching, no live update)
  resourceContent(resourceId: ResourceId): Promise<string>;
  resourceGraph(resourceId: ResourceId): Promise<GetResourceResponse>;
  /** The resource's coordinate map. Never null — absence is named, so a
   *  caller can tell "not yet" from "never". */
  resourceAnchoredText(resourceId: ResourceId): Promise<AnchoredTextAnswer>;
  resourceRepresentation(resourceId: ResourceId): Promise<{ data: ArrayBuffer; contentType: string }>;
  resourceRepresentationStream(resourceId: ResourceId): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;
  resourceEvents(resourceId: ResourceId): Promise<AttributedEvent[]>;
  annotationHistory(resourceId: ResourceId, annotationId: AnnotationId): Promise<AnnotationHistoryResponse>;
  files(dirPath?: string, sort?: 'name' | 'mtime' | 'annotationCount'): Promise<components['schemas']['BrowseFilesResponse']>;
  /**
   * What the KB says of itself — its committed name and domain, and the
   * working tree's branch — asked on every call. Never cached: a branch
   * changes with no event that could invalidate a kept answer.
   */
  kb(): Promise<KbDescription>;

  // UI signals — THIS viewer's own local fan-out, never the wire. The
  // cross-namespace pair is the rule: `browse.X()` does it for me,
  // `beckon.X()` does it for everyone else. (`resourceViewed` is the one
  // exception and goes to the wire — it is a REPORT, not a drive.)
  click(annotationId: AnnotationId, anchorRect?: AnchorRect): void;
  openResource(resourceId: ResourceId): void;
  resourceViewed(resourceId: ResourceId): void;
}

/**
 * Frame — schema-layer flow (the eighth flow).
 *
 * Frame operates on the KB's conceptual vocabulary — what *kinds* of
 * things exist (entity types) and what taxonomies are recognized (tag
 * schemas). Typed relations (predicate types) and schema import (ontology
 * I/O) are not part of it. The other seven flows (yield, mark, match,
 * bind, gather, browse, beckon) operate on content; Frame operates on the
 * schema layer that content is expressed in.
 *
 * Vocabulary writes only. Live reads of the vocabulary are on Browse
 * (`browse.entityTypes()`, `browse.tagSchemas()`). Frame owns writes;
 * Browse owns reads — the same asymmetry that holds for resources and
 * annotations.
 *
 * Gateway actor: Stower
 * Event prefix: frame:*
 */
export interface FrameNamespace {
  /** Add a single entity type to the KB's vocabulary. Idempotent — adding an existing type is a no-op. */
  addEntityType(type: string): Promise<void>;

  /** Add multiple entity types in one call. Convenience over a loop of `addEntityType`. */
  addEntityTypes(types: string[]): Promise<void>;

  /**
   * Register a tag schema with the KB's runtime registry.
   *
   * Most-recent registration of a given `schema.id` wins; identical
   * re-registrations are silent, differing content overwrites the
   * existing entry and logs a warning. KBs typically call this at
   * session/skill startup so the schema is available for `mark.delegate`
   * with motivation `tagging` and surfaces in `browse.tagSchemas()`.
   */
  addTagSchema(schema: TagSchema): Promise<void>;
}

/**
 * Mark — annotation CRUD, delegated annotation, resource lifecycle
 *
 * Commands return Promises that resolve on the confirming reply and
 * reject on failure. Results appear on browse Observables via bus gateway.
 * delegate() returns the delegated job: its events, and awaited, its completion.
 *
 * Gateway actor: Stower
 * Event prefix: mark:*
 */
export interface MarkNamespace {
  // Annotation CRUD. `input.target.source` carries the resource id; the
  // namespace derives it for the bus payload, so callers don't pass it twice.
  annotation(input: CreateAnnotationInput): Promise<{ annotationId: AnnotationId }>;
  delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void>;

  // Resource metadata
  archive(resourceId: ResourceId): Promise<void>;
  unarchive(resourceId: ResourceId): Promise<void>;

  /**
   * Replace a resource's own entity-type classification. A **diff/replace**
   * operation: pass the resource's current types as `current` and the desired
   * full set as `updated`. The gateway folds the difference into
   * `resource.entityTypes`, so the change surfaces in
   * `browse.resources({ entityType })` and `getResourceEntityTypes`. Awaitable +
   * rejects on failure, like `delete`/`archive`.
   */
  updateEntityTypes(resourceId: ResourceId, current: string[], updated: string[]): Promise<void>;

  /**
   * Annotating a resource, delegated as a `mark` job. `params` state the
   * motivation and what a job of that motivation takes, and nothing else: a
   * parameter it does not take does not compile, and is refused if sent.
   *
   * ⚠️ Cold: do NOT both `.subscribe(...)` and `await` the same instance —
   * that creates the job twice. Use `.run(onNext)` for progress + completion.
   */
  delegate(resourceId: ResourceId, params: MarkJobParams): DelegationObservable<MarkJobCompletion>;

  // UI signals (fire-and-forget bus emits, local-bus fan-out)
  /** Request a new mark on `source` — the id routes the event to the state unit bound to that resource. */
  request(
    source: ResourceId,
    selector: components['schemas']['MarkRequestedEvent']['selector'],
    motivation: Motivation,
  ): void;

  /** Fire-and-forget variant of `delegate` — mark-state-unit creates the job for its resource and follows it. */
  requestDelegate(params: MarkJobParams): void;

  /** Submit the pending annotation with its selector and optional body. */
  submit(input: components['schemas']['MarkSubmitEvent']): void;

  /** Cancel the pending annotation (if any). */
  cancelPending(): void;

  /** Dismiss the display of a delegated job's progress. */
  dismissProgress(): void;

  /**
   * UI signal: a delete failed at the caller that awaited it. `delete` rejects;
   * the caller knows whose command failed on which resource and reports it
   * here, and useOutcomeToasts surfaces it.
   */
  reportDeleteError(input: EventMap['mark:delete-error']): void;
}

/**
 * Bind — reference linking
 *
 * One command, `body()`, and two UI signals. The result (updated
 * annotation with resolved reference) arrives on browse.annotations() via
 * the enriched mark:body-updated event.
 *
 * Gateway actor: Stower (via mark:update-body)
 * Event prefix: mark:body-updated (shares mark event pipeline)
 */
export interface BindNamespace {
  body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void>;

  /** UI signal: a reference-binding flow is requested for an annotation. */
  initiate(input: EventMap['bind:initiate']): void;

  /** UI signal: a bind body update failed at an awaiting caller with no toast surface; useOutcomeToasts surfaces it. */
  reportBodyError(input: EventMap['bind:body-error']): void;
}

/**
 * Gather — context assembly
 *
 * Long-running (LLM calls + graph traversal). `annotation()` returns an
 * Observable that emits its result once and completes; `resource()`
 * returns a Promise of the gathered context.
 *
 * Gateway actor: Gatherer
 * Event prefix: gather:*
 */
export interface GatherNamespace {
  annotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    options?: { contextWindow?: number },
  ): StreamObservable<GatherAnnotationComplete>;

  resource(
    resourceId: ResourceId,
    options?: {
      depth?: number;
      maxResources?: number;
      includeContent?: boolean;
      includeSummary?: boolean;
      /** Entity types to exclude from the semantic recall built into the context
       *  (e.g. ['Question'] so prior questions never ground answer generation). */
      excludeEntityTypes?: string[];
    },
  ): Promise<GatheredContext>;

  /** Live query: the annotations elsewhere that refer to a resource. */
  referencedBy(resourceId: ResourceId): CacheObservable<ReferencedByEntry[]>;
}

/**
 * Match — search and ranking
 *
 * Long-running (semantic search, optional LLM scoring). `search()`
 * returns an Observable that emits the results once and completes.
 *
 * Gateway actor: Matcher
 * Event prefix: match:*
 */
export interface MatchNamespace {
  search(
    resourceId: ResourceId,
    referenceId: AnnotationId,
    context: GatheredContext,
    options?: { limit?: number; useSemanticScoring?: boolean },
  ): StreamObservable<MatchSearchProgress>;

  /** Fire-and-forget variant: match-state-unit orchestrates the call and its result Observable. */
  requestSearch(input: components['schemas']['MatchSearchRequest'], correlationId: string): void;

  /**
   * Live query: the resources a text search finds, lexically or, when
   * nothing matches the text, by meaning.
   */
  resources(search: string, filters?: ResourceSearchFilters): CacheObservable<MatchedResources>;
}

/**
 * Yield — resource creation
 *
 * resource() is file upload (an awaitable Observable of its phases).
 * delegate() is generation delegated as a job: its events, and awaited, its completion.
 *
 * Gateway actor: Stower + generation worker
 * Event prefix: yield:*
 */
export interface YieldNamespace {
  // File upload. Returns an `UploadObservable` — subscribers see the full
  // `UploadProgress` lifecycle (started → finished); awaiting resolves to
  // `{ resourceId }` directly.
  resource(data: CreateResourceInput): UploadObservable;

  // Grounded generation, delegated as a `yield` job. The job names no
  // resource: the focus of `params.context` does — annotation focus binds the
  // new resource to the reference; resource focus mints a source→derived
  // provenance annotation. A context without a usable focus throws
  // synchronously. `stallDeadlineMs` is the follower's own and is not sent.
  delegate(params: GenerationJobParams, stallDeadlineMs?: number): DelegationObservable<YieldJobCompletion>;

  // Clone
  cloneToken(resourceId: ResourceId): Promise<CloneResourceWithTokenResponse>;
  fromToken(token: string): Promise<ResourceDescriptor>;
  createFromToken(options: CreateFromTokenOptions): Promise<{ resourceId: ResourceId }>;

  /** UI signal: user invoked the clone action from the resource-info panel. */
  clone(): void;
}

/**
 * Beckon — attention coordination
 *
 * Ephemeral signals; nothing is recorded. The gateway relays a wire drive
 * to every connected client; a local signal stays on this client's bus.
 *
 * Gateway actor: none (the gateway relays the frame)
 * Event prefix: beckon:* (and browse:click, browse:resource-open)
 */
export interface BeckonNamespace {
  // Wire drives — beckon OTHER participants (guided-tour moves). Each
  // resolves with the subscriber count, absent when there is none
  // (ITransport.emit).
  attention(resourceId: ResourceId, annotationId: AnnotationId): Promise<number | undefined>;
  click(annotationId: AnnotationId): Promise<number | undefined>;
  openResource(resourceId: ResourceId): Promise<number | undefined>;
  sparkleAll(annotationId: AnnotationId): Promise<number | undefined>;
  // Local signals — this viewer's own fan-out; never the wire.
  hover(annotationId: AnnotationId | null): void;
  sparkle(annotationId: AnnotationId): void;
}

/**
 * Job — worker lifecycle
 */
export interface JobNamespace {
  /** Live stream of `job:queued` events from the bus. */
  readonly queued$: Observable<EventMap['job:queued']>;
  /** Live stream of `job:report-progress` events from the bus. */
  readonly progress$: Observable<EventMap['job:report-progress']>;
  /** Live stream of `job:complete` events from the bus. */
  readonly complete$: Observable<EventMap['job:complete']>;
  /** Live stream of `job:fail` events from the bus. */
  readonly fail$: Observable<EventMap['job:fail']>;

  status(jobId: JobId): Promise<JobStatusResponse>;
  pollUntilComplete(jobId: JobId, options?: { interval?: number; timeout?: number; onProgress?: (status: JobStatusResponse) => void }): Promise<JobStatusResponse>;
  cancelByType(jobType: JobType): Promise<number>;
  /** Cancel ONE job by id; resolves with the count the queue acted on. */
  cancel(jobId: JobId): Promise<number>;

  /** UI signal, local bus only: a viewer asks for the jobs of a type to be cancelled. `cancelByType` is the call that cancels. */
  cancelRequest(jobType: JobType): void;
}

/**
 * Auth — authentication
 */
export interface AuthNamespace {
  me(): Promise<User>;
  mediaToken(resourceId: ResourceId): Promise<{ token: string }>;
  /** RFC 9728: which issuer the knowledge base trusts — where to send a user to sign in. */
  protectedResourceMetadata(): Promise<ProtectedResourceMetadata>;
}

/**
 * System — what the knowledge base says about itself (health, status).
 */
export interface SystemNamespace {
  healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>>;
  status(): Promise<ResponseContent<paths['/api/status']['get']>>;
}
