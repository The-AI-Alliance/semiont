/**
 * Verb Namespace Interfaces
 *
 * These interfaces define the public API of the Semiont api-client,
 * organized by the 7 domain flows (Browse, Mark, Bind, Gather, Match,
 * Yield, Beckon) plus infrastructure namespaces (Job, Auth, Admin).
 *
 * Each namespace maps 1:1 to a flow. Each flow maps to a clear actor
 * on the backend. The frontend calls `client.mark.annotation()` and the
 * proxy handles HTTP, auth, SSE, and caching internally.
 *
 * Return type conventions:
 * - Browse live queries → Observable (bus gateway driven, cached)
 * - Browse one-shot reads → Promise (fetch once, no cache)
 * - Commands (mark, bind, yield.resource) → Promise (fire-and-forget)
 * - Long-running ops (gather, match, yield.fromAnnotation, mark.assist) → Observable (progress + result)
 * - Ephemeral signals (beckon) → void
 */

import type { Observable } from 'rxjs';
import type { components, EventMap, paths } from '@semiont/core';
import type {
  ResourceId,
  AnnotationId,
  BodyOperation,
  GraphConnection,
  JobId,
  Motivation,
  GatheredContext,
  UserDID,
} from '@semiont/core';

// ── OpenAPI schema type aliases ─────────────────────────────────────────────

import type { Annotation } from '@semiont/core';
import type { ResourceDescriptor } from '@semiont/core';
type StoredEventResponse = components['schemas']['StoredEventResponse'];
type GatherProgress = components['schemas']['GatherProgress'];
type MatchSearchResult = components['schemas']['MatchSearchResult'];
type JobProgress = components['schemas']['JobProgress'];
type YieldProgress = JobProgress;  // alias retained for the yield namespace's Observable signature
type GatherAnnotationComplete = components['schemas']['GatherAnnotationComplete'];
type JobStatusResponse = components['schemas']['JobStatusResponse'];
type AuthResponse = components['schemas']['AuthResponse'];
type OAuthConfigResponse = components['schemas']['OAuthConfigResponse'];
type AdminUserStatsResponse = components['schemas']['AdminUserStatsResponse'];

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
  creationMethod?: string;
  sourceAnnotationId?: string;
  sourceResourceId?: string;
  storageUri: string;
  /** Prompt that drove AI generation (for AI-generated resources). */
  generationPrompt?: string;
  /** Agent(s) that generated the content (for AI-generated resources). */
  generator?: components['schemas']['Agent'] | components['schemas']['Agent'][];
  isDraft?: boolean;
}

/** Options for yield.fromAnnotation() */
export interface GenerationOptions {
  title: string;
  storageUri: string;
  context: GatheredContext;
  prompt?: string;
  language?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Options for mark.assist() */
export interface MarkAssistOptions {
  entityTypes?: string[];
  includeDescriptiveReferences?: boolean;
  instructions?: string;
  density?: number;
  tone?: string;
  language?: string;
  schemaId?: string;
  categories?: string[];
}

/** Options for yield.createFromToken() */
export type CreateFromTokenOptions = { token: string; name: string; content: string; archiveOriginal?: boolean };

/** Referenced-by entry from browse.referencedBy() */
export type ReferencedByEntry = components['schemas']['GetReferencedByResponse']['referencedBy'][number];

/** Annotation history from browse.annotationHistory() */
export type AnnotationHistoryResponse = components['schemas']['GetAnnotationHistoryResponse'];

/** User object from auth/admin responses */
export type User = AuthResponse['user'];

// ── Progress types for long-running Observable operations ───────────────────

/**
 * Progress emitted by gather.annotation() Observable.
 * Emits GatherProgress during assembly, then GatherAnnotationComplete on finish.
 */
export type GatherAnnotationProgress = GatherProgress | GatherAnnotationComplete;

/**
 * Progress emitted by match.search() Observable.
 * Emits the final MatchSearchResult (no intermediate progress events currently).
 */
export type MatchSearchProgress = MatchSearchResult;

/**
 * Progress emitted by mark.assist() Observable.
 * Each emission is a JobProgress snapshot (unified job lifecycle). The
 * Observable completes on `job:complete`; errors on `job:fail`.
 */
export type MarkAssistProgress = JobProgress;

// ── Namespace interfaces ────────────────────────────────────────────────────

/**
 * Browse — reads from materialized views
 *
 * Live queries return Observables that emit initial state and re-emit
 * on bus gateway updates. One-shot reads return Promises.
 *
 * Backend actor: Browser (context classes)
 * Event prefix: browse:*
 */
export interface BrowseNamespace {
  // Live queries (Observable — bus gateway driven, cached in BehaviorSubject)
  resource(resourceId: ResourceId): Observable<ResourceDescriptor | undefined>;
  resources(filters?: { limit?: number; archived?: boolean; search?: string }): Observable<ResourceDescriptor[] | undefined>;
  annotations(resourceId: ResourceId): Observable<Annotation[] | undefined>;
  annotation(resourceId: ResourceId, annotationId: AnnotationId): Observable<Annotation | undefined>;
  entityTypes(): Observable<string[] | undefined>;
  referencedBy(resourceId: ResourceId): Observable<ReferencedByEntry[] | undefined>;
  events(resourceId: ResourceId): Observable<StoredEventResponse[] | undefined>;

  // One-shot reads (Promise — no caching, no live update)
  resourceContent(resourceId: ResourceId): Promise<string>;
  resourceRepresentation(resourceId: ResourceId, options?: { accept?: string }): Promise<{ data: ArrayBuffer; contentType: string }>;
  resourceRepresentationStream(resourceId: ResourceId, options?: { accept?: string }): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;
  resourceEvents(resourceId: ResourceId): Promise<StoredEventResponse[]>;
  annotationHistory(resourceId: ResourceId, annotationId: AnnotationId): Promise<AnnotationHistoryResponse>;
  connections(resourceId: ResourceId): Promise<GraphConnection[]>;
  backlinks(resourceId: ResourceId): Promise<Annotation[]>;
  resourcesByName(query: string, limit?: number): Promise<ResourceDescriptor[]>;
  files(dirPath?: string, sort?: 'name' | 'mtime' | 'annotationCount'): Promise<components['schemas']['BrowseFilesResponse']>;

  // UI signals (fire-and-forget, broadcast to other participants via the bus)
  click(annotationId: AnnotationId, motivation: Motivation): void;
  navigateReference(resourceId: ResourceId): void;
}

/**
 * Mark — annotation CRUD, entity types, AI assist
 *
 * Commands return Promises that resolve on HTTP acceptance (202).
 * Results appear on browse Observables via bus gateway.
 * assist() returns an Observable for long-running progress.
 *
 * Backend actor: Stower
 * Event prefix: mark:*
 */
export interface MarkNamespace {
  // Annotation CRUD
  annotation(resourceId: ResourceId, input: CreateAnnotationInput): Promise<{ annotationId: string }>;
  delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void>;

  // Entity types
  entityType(type: string): Promise<void>;
  entityTypes(types: string[]): Promise<void>;

  // Resource metadata
  archive(resourceId: ResourceId): Promise<void>;
  unarchive(resourceId: ResourceId): Promise<void>;

  // AI-assisted annotation (long-running, returns Observable with progress)
  assist(resourceId: ResourceId, motivation: Motivation, options: MarkAssistOptions): Observable<MarkAssistProgress>;

  // UI signals (fire-and-forget bus emits, local-bus fan-out)
  request(
    selector: components['schemas']['MarkRequestedEvent']['selector'],
    motivation: Motivation,
  ): void;

  /** Fire-and-forget variant of `assist` — mark-vm orchestrates the call and its progress Observable. */
  requestAssist(motivation: Motivation, options: MarkAssistOptions, correlationId?: string): void;

  /** Submit the currently pending annotation with its selector and optional body. */
  submit(input: components['schemas']['MarkSubmitEvent']): void;

  /** Cancel the currently pending annotation (if any). */
  cancelPending(): void;

  /** Dismiss the in-progress AI-assist widget. */
  dismissProgress(): void;

  // Annotate-toolbar UI state signals (local fan-out to VMs + cross-tab via bus)
  changeSelection(motivation: Motivation | null): void;
  changeClick(action: string): void;
  changeShape(shape: string): void;
  toggleMode(): void;
}

/**
 * Bind — reference linking
 *
 * The simplest namespace. One method. The result (updated annotation
 * with resolved reference) arrives on browse.annotations() via the
 * enriched mark:body-updated event.
 *
 * Backend actor: Stower (via mark:update-body)
 * Event prefix: mark:body-updated (shares mark event pipeline)
 */
export interface BindNamespace {
  body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void>;

  /** UI signal: a reference-binding flow is requested for an annotation. */
  initiate(input: EventMap['bind:initiate']): void;
}

/**
 * Gather — context assembly
 *
 * Long-running (LLM calls + graph traversal). Returns Observables
 * that emit progress then the gathered context.
 *
 * Backend actor: Gatherer
 * Event prefix: gather:*
 */
export interface GatherNamespace {
  annotation(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    options?: { contextWindow?: number },
  ): Observable<GatherAnnotationProgress>;

  resource(
    resourceId: ResourceId,
    options?: { contextWindow?: number },
  ): Observable<GatherAnnotationProgress>;
}

/**
 * Match — search and ranking
 *
 * Long-running (semantic search, optional LLM scoring). Returns
 * Observable with progress then results.
 *
 * Backend actor: Matcher
 * Event prefix: match:*
 */
export interface MatchNamespace {
  search(
    resourceId: ResourceId,
    referenceId: string,
    context: GatheredContext,
    options?: { limit?: number; useSemanticScoring?: boolean },
  ): Observable<MatchSearchProgress>;

  /** Fire-and-forget variant: match-vm orchestrates the call and its result Observable. */
  requestSearch(input: components['schemas']['MatchSearchRequest']): void;
}

/**
 * Yield — resource creation
 *
 * resource() is synchronous file upload (Promise).
 * fromAnnotation() is long-running LLM generation (Observable).
 *
 * Backend actor: Stower + generation worker
 * Event prefix: yield:*
 */
export interface YieldNamespace {
  // File upload (synchronous)
  resource(data: CreateResourceInput): Promise<{ resourceId: string }>;

  // Generation from annotation (long-running, LLM-based)
  fromAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    options: GenerationOptions,
  ): Observable<YieldProgress>;

  // Clone
  cloneToken(resourceId: ResourceId): Promise<{ token: string; expiresAt: string }>;
  fromToken(token: string): Promise<ResourceDescriptor>;
  createFromToken(options: CreateFromTokenOptions): Promise<{ resourceId: string }>;

  /** UI signal: user invoked the clone action from the resource-info panel. */
  clone(): void;
}

/**
 * Beckon — attention coordination
 *
 * Fire-and-forget. Ephemeral presence signal delivered via the
 * attention-stream to other participants.
 *
 * Backend actor: (frontend relay via attention-stream)
 * Event prefix: beckon:*
 */
export interface BeckonNamespace {
  attention(annotationId: AnnotationId, resourceId: ResourceId): void;
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
  cancel(jobId: JobId, type: string): Promise<void>;

  /** UI signal: cancel all active jobs of a given type (e.g. "annotation"). */
  cancelRequest(jobType: 'annotation' | 'generation'): void;
}

/**
 * Auth — authentication
 */
export interface AuthNamespace {
  password(email: string, password: string): Promise<AuthResponse>;
  google(credential: string): Promise<AuthResponse>;
  refresh(token: string): Promise<AuthResponse>;
  logout(): Promise<void>;
  me(): Promise<User>;
  acceptTerms(): Promise<void>;
  mcpToken(): Promise<{ token: string }>;
  mediaToken(resourceId: ResourceId): Promise<{ token: string }>;
}

/**
 * Admin — administration
 */
export interface AdminNamespace {
  users(): Promise<User[]>;
  userStats(): Promise<AdminUserStatsResponse>;
  updateUser(userId: UserDID, data: RequestContent<paths['/api/admin/users/{id}']['patch']>): Promise<User>;
  oauthConfig(): Promise<OAuthConfigResponse>;
  healthCheck(): Promise<ResponseContent<paths['/api/health']['get']>>;
  status(): Promise<ResponseContent<paths['/api/status']['get']>>;
  backup(): Promise<Response>;
  restore(file: File, onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }>;
  exportKnowledgeBase(params?: { includeArchived?: boolean }): Promise<Response>;
  importKnowledgeBase(file: File, onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }>;
}
