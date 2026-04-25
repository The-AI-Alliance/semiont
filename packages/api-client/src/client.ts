/**
 * SemiontClient — the verb-oriented namespace surface.
 *
 * Thin coordinator over an injected transport pair. Owns a local
 * `EventBus` (`bus`) for UI-signal channels and bridges wire events into
 * it via `transport.bridgeInto(bus)`. Namespaces receive `(transport,
 * bus)` (and `content` for binary-I/O namespaces) and choose internally
 * whether each method goes over the wire or stays local.
 *
 * No public `emit`/`on`/`stream` shortcuts: consumers call typed
 * namespace methods. The single sanctioned channel-by-name escape hatch
 * is `SemiontSession.subscribe(channel, handler)`, which reads from
 * `client.bus`.
 *
 * Legacy bulk methods (e.g. `browseResource`, `markAnnotation`) remain on
 * the class for CLI / MCP consumers that have not yet migrated to typed
 * namespace methods. Those route through `this.transport`.
 */

import type { paths, components } from '@semiont/core';
import type {
  ResourceId,
  AnnotationId,
  AccessToken,
  BaseUrl,
  BodyOperation,
  CloneToken,
  ContentFormat,
  Email,
  EntityType,
  GoogleCredential,
  JobId,
  Motivation,
  RefreshToken,
  SearchQuery,
  UserDID,
} from '@semiont/core';
import { EventBus } from '@semiont/core';
import { busRequest } from './bus-request';
import { BrowseNamespace } from './namespaces/browse';
import { MarkNamespace } from './namespaces/mark';
import { BindNamespace } from './namespaces/bind';
import { GatherNamespace } from './namespaces/gather';
import { MatchNamespace } from './namespaces/match';
import { YieldNamespace } from './namespaces/yield';
import { BeckonNamespace } from './namespaces/beckon';
import { JobNamespace } from './namespaces/job';
import { AuthNamespace } from './namespaces/auth';
import { AdminNamespace } from './namespaces/admin';
import type { ITransport, IContentTransport } from './transport/types';

export { APIError, type TokenRefresher, HttpTransport, type HttpTransportConfig } from './transport/http-transport';
export { HttpContentTransport } from './transport/http-content-transport';

// Type helpers to extract request/response types from OpenAPI paths
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } }
  ? R
  : T extends { responses: { 201: { content: { 'application/json': infer R } } } }
    ? R
    : T extends { responses: { 202: { content: { 'application/json': infer R } } } }
      ? R
      : never;

type RequestContent<T> = T extends { requestBody?: { content: { 'application/json': infer R } } } ? R : never;

export interface RequestOptions {
  /** Access token for this request */
  auth?: AccessToken;
}

export class SemiontClient {
  /**
   * The wire-facing transport. Owns bus actor, HTTP, auth, admin, exchange,
   * system. Exposed for advanced consumers (workers, custom job adapters)
   * that need raw `transport.emit(channel, payload, scope)` access. Ordinary
   * consumers go through typed namespace methods.
   */
  readonly transport: ITransport;
  /** Binary I/O transport. */
  private readonly content: IContentTransport;
  /**
   * Per-client local EventBus. Wire events flow in via the transport
   * bridge. Read-only public so `SemiontSession.subscribe(channel, …)`
   * can wire arbitrary-channel subscriptions; everything else uses
   * typed namespace methods.
   */
  readonly bus: EventBus;
  readonly baseUrl: BaseUrl;

  // ── Verb-oriented namespace API ──────────────────────────────────────────
  public readonly browse: BrowseNamespace;
  public readonly mark: MarkNamespace;
  public readonly bind: BindNamespace;
  public readonly gather: GatherNamespace;
  public readonly match: MatchNamespace;
  public readonly yield: YieldNamespace;
  public readonly beckon: BeckonNamespace;
  public readonly job: JobNamespace;
  public readonly auth: AuthNamespace;
  public readonly admin: AdminNamespace;

  /**
   * The client *owns* its bus. The constructor creates a fresh `EventBus`
   * and hands it to the transport via `transport.bridgeInto(this.bus)`.
   * The reference flows client → transport, never the other way:
   *   - `HttpTransport.bridgeInto(bus)` pumps SSE events into the bus.
   *   - `LocalTransport.bridgeInto(bus)` wires its in-process
   *     KnowledgeSystem actors to emit/listen on that bus, so client and
   *     KnowledgeSystem share one bus by construction.
   *
   * Callers do not pass a bus in. If they need to interact with the bus
   * (e.g. for tests or to subscribe to arbitrary channels), they read it
   * back via `client.bus`.
   */
  constructor(transport: ITransport, content: IContentTransport) {
    this.transport = transport;
    this.content = content;
    this.baseUrl = transport.baseUrl;

    this.bus = new EventBus();
    this.transport.bridgeInto(this.bus);

    this.browse = new BrowseNamespace(this.transport, this.bus, this.content);
    this.mark   = new MarkNamespace(this.transport, this.bus);
    this.bind   = new BindNamespace(this.transport, this.bus);
    this.gather = new GatherNamespace(this.transport, this.bus);
    this.match  = new MatchNamespace(this.transport, this.bus);
    this.yield  = new YieldNamespace(this.transport, this.bus, this.content);
    this.beckon = new BeckonNamespace(this.transport, this.bus);
    this.job    = new JobNamespace(this.transport, this.bus);
    this.auth   = new AuthNamespace(this.transport);
    this.admin  = new AdminNamespace(this.transport);
  }

  /** Transport-level connection state. HTTP reflects SSE health; local is always 'connected'. */
  get state$() {
    return this.transport.state$;
  }

  subscribeToResource(resourceId: ResourceId): () => void {
    return this.transport.subscribeToResource(resourceId);
  }

  dispose(): void {
    this.transport.dispose();
    this.content.dispose();
  }

  // ── AUTH (delegates to HttpTransport) ─────────────────────────────────

  async authenticatePassword(email: Email, password: string, _options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/password']['post']>> {
    return this.transport.authenticatePassword(email, password) as unknown as Promise<ResponseContent<paths['/api/tokens/password']['post']>>;
  }

  async refreshToken(token: RefreshToken, _options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/refresh']['post']>> {
    return this.transport.refreshAccessToken(token) as unknown as Promise<ResponseContent<paths['/api/tokens/refresh']['post']>>;
  }

  async authenticateGoogle(credential: GoogleCredential, _options?: RequestOptions): Promise<ResponseContent<paths['/api/tokens/google']['post']>> {
    return this.transport.authenticateGoogle(credential) as unknown as Promise<ResponseContent<paths['/api/tokens/google']['post']>>;
  }

  async getMediaToken(resourceId: ResourceId, _options?: RequestOptions): Promise<{ token: string }> {
    return this.transport.getMediaToken(resourceId);
  }

  async getMe(_options?: RequestOptions): Promise<ResponseContent<paths['/api/users/me']['get']>> {
    return this.transport.getCurrentUser() as unknown as Promise<ResponseContent<paths['/api/users/me']['get']>>;
  }

  async acceptTerms(_options?: RequestOptions): Promise<ResponseContent<paths['/api/users/accept-terms']['post']>> {
    await this.transport.acceptTerms();
    return undefined as unknown as ResponseContent<paths['/api/users/accept-terms']['post']>;
  }

  async logout(_options?: RequestOptions): Promise<ResponseContent<paths['/api/users/logout']['post']>> {
    await this.transport.logout();
    return undefined as unknown as ResponseContent<paths['/api/users/logout']['post']>;
  }

  // ── BINARY I/O (delegates to HttpContentTransport) ────────────────────

  async yieldResource(data: {
    name: string;
    file: File | Buffer;
    format: string;
    entityTypes?: string[];
    language?: string;
    creationMethod?: string;
    sourceAnnotationId?: string;
    sourceResourceId?: string;
    storageUri: string;
    generationPrompt?: string;
    generator?: components['schemas']['Agent'] | components['schemas']['Agent'][];
    isDraft?: boolean;
  }, options?: RequestOptions): Promise<ResponseContent<paths['/resources']['post']>> {
    const result = await this.content.putBinary(
      {
        name: data.name,
        file: data.file,
        format: data.format,
        storageUri: data.storageUri,
        ...(data.entityTypes ? { entityTypes: data.entityTypes } : {}),
        ...(data.language ? { language: data.language } : {}),
        ...(data.creationMethod ? { creationMethod: data.creationMethod } : {}),
        ...(data.sourceAnnotationId ? { sourceAnnotationId: data.sourceAnnotationId } : {}),
        ...(data.sourceResourceId ? { sourceResourceId: data.sourceResourceId } : {}),
        ...(data.generationPrompt ? { generationPrompt: data.generationPrompt } : {}),
        ...(data.generator ? { generator: data.generator } : {}),
        ...(data.isDraft !== undefined ? { isDraft: data.isDraft } : {}),
      },
      options?.auth ? { auth: options.auth } : undefined,
    );
    return result as unknown as ResponseContent<paths['/resources']['post']>;
  }

  async getResourceRepresentation(
    id: ResourceId,
    options?: { accept?: ContentFormat; auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    return this.content.getBinary(id, {
      ...(options?.accept ? { accept: options.accept } : {}),
      ...(options?.auth ? { auth: options.auth } : {}),
    });
  }

  async getResourceRepresentationStream(
    id: ResourceId,
    options?: { accept?: ContentFormat; auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    return this.content.getBinaryStream(id, {
      ...(options?.accept ? { accept: options.accept } : {}),
      ...(options?.auth ? { auth: options.auth } : {}),
    });
  }

  // ── LEGACY BUS/HTTP PASSTHROUGHS (unchanged during the migration) ─────
  //
  // These methods are used by CLI / MCP consumers that have not yet
  // migrated to typed namespace methods (e.g. `semiont.browse.resource`).
  // They route through `this.transport` (bus emit + busRequest) directly,
  // both now owned by HttpTransport.

  async browseResource(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['GetResourceResponse']> {
    return busRequest(this.transport, 'browse:resource-requested', { resourceId: id }, 'browse:resource-result', 'browse:resource-failed');
  }

  async browseResources(
    limit?: number,
    archived?: boolean,
    query?: SearchQuery,
    _options?: RequestOptions,
  ): Promise<components['schemas']['ListResourcesResponse']> {
    return busRequest(this.transport, 'browse:resources-requested',
      { search: query, archived, limit: limit ?? 100, offset: 0 },
      'browse:resources-result', 'browse:resources-failed');
  }

  async getResourceEvents(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['GetEventsResponse']> {
    return busRequest(this.transport, 'browse:events-requested', { resourceId: id }, 'browse:events-result', 'browse:events-failed');
  }

  async browseReferences(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['GetReferencedByResponse']> {
    return busRequest(this.transport, 'browse:referenced-by-requested', { resourceId: id }, 'browse:referenced-by-result', 'browse:referenced-by-failed');
  }

  async generateCloneToken(id: ResourceId, _options?: RequestOptions): Promise<components['schemas']['CloneResourceWithTokenResponse']> {
    return busRequest(this.transport, 'yield:clone-token-requested', { resourceId: id }, 'yield:clone-token-generated', 'yield:clone-token-failed');
  }

  async getResourceByToken(token: CloneToken, _options?: RequestOptions): Promise<components['schemas']['GetResourceByTokenResponse']> {
    return busRequest(this.transport, 'yield:clone-resource-requested', { token }, 'yield:clone-resource-result', 'yield:clone-resource-failed');
  }

  async createResourceFromToken(
    data: { token: string; name: string; content: string; archiveOriginal?: boolean },
    _options?: RequestOptions,
  ): Promise<{ resourceId: string }> {
    return busRequest(this.transport, 'yield:clone-create', data as unknown as Record<string, unknown>, 'yield:clone-created', 'yield:clone-create-failed');
  }

  // ── ANNOTATIONS (bus passthroughs) ────────────────────────────────────

  async markAnnotation(
    resourceId: ResourceId,
    request: components['schemas']['CreateAnnotationRequest'],
    _options?: RequestOptions,
  ): Promise<{ annotationId: string }> {
    return busRequest<{ annotationId: string }>(this.transport, 'mark:create-request',
      { resourceId, request: request as unknown as Record<string, unknown> },
      'mark:create-ok', 'mark:create-failed');
  }

  async getAnnotation(id: AnnotationId, _options?: RequestOptions): Promise<components['schemas']['GetAnnotationResponse']> {
    return busRequest(this.transport, 'browse:annotation-requested', { annotationId: id }, 'browse:annotation-result', 'browse:annotation-failed');
  }

  async browseAnnotation(resourceId: ResourceId, annotationId: AnnotationId, _options?: RequestOptions): Promise<components['schemas']['GetAnnotationResponse']> {
    return busRequest(this.transport, 'browse:annotation-requested', { resourceId, annotationId }, 'browse:annotation-result', 'browse:annotation-failed');
  }

  async browseAnnotations(
    id: ResourceId,
    _motivation?: Motivation,
    _options?: RequestOptions,
  ): Promise<components['schemas']['GetAnnotationsResponse']> {
    return busRequest(this.transport, 'browse:annotations-requested', { resourceId: id }, 'browse:annotations-result', 'browse:annotations-failed');
  }

  async deleteAnnotation(resourceId: ResourceId, annotationId: AnnotationId, _options?: RequestOptions): Promise<void> {
    await this.transport.emit('mark:delete', { annotationId, resourceId });
  }

  async bindAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { operations: BodyOperation[] },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string }> {
    const correlationId = crypto.randomUUID();
    await this.transport.emit('bind:update-body', { correlationId, annotationId, resourceId, operations: data.operations });
    return { correlationId };
  }

  async getAnnotationHistory(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    _options?: RequestOptions,
  ): Promise<components['schemas']['GetAnnotationHistoryResponse']> {
    return busRequest(this.transport, 'browse:annotation-history-requested', { resourceId, annotationId }, 'browse:annotation-history-result', 'browse:annotation-history-failed');
  }

  // ── ANNOTATION ASSIST (jobs) ──────────────────────────────────────────

  async annotateReferences(
    resourceId: ResourceId,
    data: { entityTypes: string[]; includeDescriptiveReferences?: boolean },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.transport, 'job:create',
      { jobType: 'reference-annotation', resourceId, params: data as unknown as Record<string, unknown> },
      'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async annotateHighlights(
    resourceId: ResourceId,
    data: { instructions?: string; density?: number },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.transport, 'job:create',
      { jobType: 'highlight-annotation', resourceId, params: data as unknown as Record<string, unknown> },
      'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async annotateTags(
    resourceId: ResourceId,
    data: { schemaId: string; categories: string[] },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.transport, 'job:create',
      { jobType: 'tag-annotation', resourceId, params: data as unknown as Record<string, unknown> },
      'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async yieldResourceFromAnnotation(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { title: string; storageUri: string; context: Record<string, unknown> },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string; jobId: string }> {
    const { jobId } = await busRequest<{ jobId: string }>(this.transport, 'job:create',
      {
        jobType: 'generation',
        resourceId,
        params: {
          referenceId: annotationId,
          title: data.title,
          storageUri: data.storageUri,
          context: data.context,
        },
      },
      'job:created', 'job:create-failed');
    return { correlationId: crypto.randomUUID(), jobId };
  }

  async gatherAnnotationContext(
    resourceId: ResourceId,
    annotationId: AnnotationId,
    data: { correlationId: string; contextWindow?: number },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string }> {
    await this.transport.emit('gather:requested', {
      correlationId: data.correlationId,
      annotationId,
      resourceId,
      options: { contextWindow: data.contextWindow ?? 2000 },
    });
    return { correlationId: data.correlationId };
  }

  async matchSearch(
    resourceId: ResourceId,
    data: { correlationId: string; referenceId: string; context: unknown; limit?: number; useSemanticScoring?: boolean },
    _options?: RequestOptions,
  ): Promise<{ correlationId: string }> {
    await this.transport.emit('match:search-requested', {
      correlationId: data.correlationId,
      resourceId,
      referenceId: data.referenceId,
      context: data.context as never,
      limit: data.limit ?? 10,
      useSemanticScoring: data.useSemanticScoring ?? true,
    });
    return { correlationId: data.correlationId };
  }

  // ── ENTITY TYPES ──────────────────────────────────────────────────────

  async addEntityType(type: EntityType, _options?: RequestOptions): Promise<void> {
    await this.transport.emit('mark:add-entity-type', { tag: type });
  }

  async addEntityTypesBulk(types: EntityType[], _options?: RequestOptions): Promise<void> {
    for (const tag of types) {
      await this.transport.emit('mark:add-entity-type', { tag });
    }
  }

  async listEntityTypes(_options?: RequestOptions): Promise<components['schemas']['GetEntityTypesResponse']> {
    return busRequest(this.transport, 'browse:entity-types-requested', {}, 'browse:entity-types-result', 'browse:entity-types-failed');
  }

  // ── PARTICIPANTS ──────────────────────────────────────────────────────

  async beckonAttention(
    _participantId: string,
    data: { annotationId?: string; resourceId: string; message?: string },
    _options?: RequestOptions,
  ): Promise<components['schemas']['BeckonResponse']> {
    await this.transport.emit('beckon:focus', data as unknown as Record<string, unknown>);
    return {} as components['schemas']['BeckonResponse'];
  }

  // ── ADMIN (delegates to HttpTransport) ────────────────────────────────

  async listUsers(_options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/users']['get']>> {
    return this.transport.listUsers() as Promise<ResponseContent<paths['/api/admin/users']['get']>>;
  }

  async getUserStats(_options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/users/stats']['get']>> {
    return this.transport.getUserStats() as Promise<ResponseContent<paths['/api/admin/users/stats']['get']>>;
  }

  async updateUser(
    id: UserDID,
    data: RequestContent<paths['/api/admin/users/{id}']['patch']>,
    _options?: RequestOptions,
  ): Promise<ResponseContent<paths['/api/admin/users/{id}']['patch']>> {
    return this.transport.updateUser(id, data) as Promise<ResponseContent<paths['/api/admin/users/{id}']['patch']>>;
  }

  async getOAuthConfig(_options?: RequestOptions): Promise<ResponseContent<paths['/api/admin/oauth/config']['get']>> {
    return this.transport.getOAuthConfig() as Promise<ResponseContent<paths['/api/admin/oauth/config']['get']>>;
  }

  // ── EXCHANGE (delegates to HttpTransport) ─────────────────────────────

  async backupKnowledgeBase(_options?: RequestOptions): Promise<Response> {
    return this.transport.backupKnowledgeBase();
  }

  async restoreKnowledgeBase(
    file: File,
    options?: RequestOptions & {
      onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void;
    },
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.transport.restoreKnowledgeBase(file, options?.onProgress);
  }

  async exportKnowledgeBase(
    params?: { includeArchived?: boolean },
    _options?: RequestOptions,
  ): Promise<Response> {
    return this.transport.exportKnowledgeBase(params);
  }

  async importKnowledgeBase(
    file: File,
    options?: RequestOptions & {
      onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void;
    },
  ): Promise<{ phase: string; message?: string; result?: Record<string, unknown> }> {
    return this.transport.importKnowledgeBase(file, options?.onProgress);
  }

  // ── JOB STATUS ────────────────────────────────────────────────────────

  async getJobStatus(id: JobId, _options?: RequestOptions): Promise<components['schemas']['JobStatusResponse']> {
    return busRequest(this.transport, 'job:status-requested', { jobId: id }, 'job:status-result', 'job:status-failed');
  }

  // ── SYSTEM STATUS (delegates to HttpTransport) ────────────────────────

  async healthCheck(_options?: RequestOptions): Promise<ResponseContent<paths['/api/health']['get']>> {
    return this.transport.healthCheck() as Promise<ResponseContent<paths['/api/health']['get']>>;
  }

  async getStatus(_options?: RequestOptions): Promise<ResponseContent<paths['/api/status']['get']>> {
    return this.transport.getStatus() as Promise<ResponseContent<paths['/api/status']['get']>>;
  }

  async browseFiles(
    dirPath?: string,
    sort?: 'name' | 'mtime' | 'annotationCount',
    _options?: RequestOptions,
  ): Promise<components['schemas']['BrowseFilesResponse']> {
    return busRequest(this.transport, 'browse:directory-requested',
      { path: dirPath ?? '.', sort: sort ?? 'name' },
      'browse:directory-result', 'browse:directory-failed');
  }
}

// Suppress "unused imports" warnings when the surface uses them only via type
// positions that the compiler already elides.
export type { Motivation };
