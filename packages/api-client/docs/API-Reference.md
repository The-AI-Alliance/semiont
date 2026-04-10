# API Reference

Complete method documentation for `@semiont/api-client`.

## Constructor

```typescript
new SemiontApiClient(config: SemiontApiClientConfig)
```

| Option | Type | Required | Description |
|---|---|---|---|
| `baseUrl` | `BaseUrl` | yes | Backend API URL |
| `eventBus` | `EventBus` | yes | Workspace-scoped EventBus |
| `getToken` | `() => AccessToken \| undefined` | no | Token getter for all namespace methods |
| `timeout` | `number` | no | Request timeout ms (default: 30000) |
| `retry` | `number` | no | Retry attempts (default: 2) |
| `logger` | `Logger` | no | Logger for HTTP/SSE observability |
| `tokenRefresher` | `() => Promise<string \| null>` | no | 401-recovery hook |

### `setTokenGetter(getter)`

Update the token getter for all namespaces. Called from the auth layer when the token changes.

## semiont.browse

Reads from materialized views. Live queries return Observables; one-shot reads return Promises.

| Method | Return | Description |
|---|---|---|
| `resource(id)` | `Observable<ResourceDescriptor \| undefined>` | Single resource, live-updating |
| `resources(filters?)` | `Observable<ResourceDescriptor[] \| undefined>` | Resource list, live-updating |
| `annotations(id)` | `Observable<Annotation[] \| undefined>` | Annotations for resource, live-updating |
| `annotation(rid, aid)` | `Observable<Annotation \| undefined>` | Single annotation, live-updating |
| `entityTypes()` | `Observable<string[] \| undefined>` | All entity types, live-updating |
| `referencedBy(id)` | `Observable<ReferencedByEntry[] \| undefined>` | Incoming references, live-updating |
| `resourceContent(id)` | `Promise<string>` | Text content |
| `resourceRepresentation(id, opts?)` | `Promise<{ data, contentType }>` | Binary content |
| `resourceRepresentationStream(id, opts?)` | `Promise<{ stream, contentType }>` | Streaming binary |
| `resourceEvents(id)` | `Promise<StoredEventResponse[]>` | Event history |
| `annotationHistory(rid, aid)` | `Promise<AnnotationHistoryResponse>` | Annotation event history |
| `connections(id)` | `Promise<GraphConnection[]>` | Graph connections (not yet implemented) |
| `backlinks(id)` | `Promise<Annotation[]>` | Backlink annotations (not yet implemented) |
| `resourcesByName(query, limit?)` | `Promise<ResourceDescriptor[]>` | Text search (not yet implemented) |
| `files(path?, sort?)` | `Promise<BrowseFilesResponse>` | File browser |

## semiont.mark

Annotation CRUD, entity types, AI assist. Commands resolve on HTTP acceptance; results arrive on browse Observables.

| Method | Return | Description |
|---|---|---|
| `annotation(rid, input)` | `Promise<{ annotationId }>` | Create annotation |
| `delete(rid, aid)` | `Promise<void>` | Delete annotation |
| `entityType(type)` | `Promise<void>` | Add single entity type |
| `entityTypes(types)` | `Promise<void>` | Add multiple entity types |
| `updateResource(rid, data)` | `Promise<void>` | Update resource metadata |
| `archive(rid)` | `Promise<void>` | Archive resource |
| `unarchive(rid)` | `Promise<void>` | Unarchive resource |
| `assist(rid, motivation, opts)` | `Observable<MarkAssistProgress>` | AI-assisted annotation with progress |

## semiont.bind

| Method | Return | Description |
|---|---|---|
| `body(rid, aid, operations)` | `Promise<void>` | Update annotation body (link/unlink references) |

## semiont.gather

| Method | Return | Description |
|---|---|---|
| `annotation(aid, rid, opts?)` | `Observable<GatherAnnotationProgress>` | Gather LLM context for annotation |
| `resource(rid, opts?)` | `Observable<GatherAnnotationProgress>` | Gather LLM context for resource |

## semiont.match

| Method | Return | Description |
|---|---|---|
| `search(rid, refId, context, opts?)` | `Observable<MatchSearchProgress>` | Semantic search for binding candidates |

## semiont.yield

| Method | Return | Description |
|---|---|---|
| `resource(data)` | `Promise<{ resourceId }>` | File upload |
| `fromAnnotation(rid, aid, opts)` | `Observable<YieldProgress>` | AI generation from annotation |
| `cloneToken(rid)` | `Promise<{ token, expiresAt }>` | Generate clone token |
| `fromToken(token)` | `Promise<ResourceDescriptor>` | Get resource by clone token |
| `createFromToken(opts)` | `Promise<{ resourceId }>` | Create resource from clone token |

## semiont.beckon

| Method | Return | Description |
|---|---|---|
| `attention(aid, rid)` | `void` | Ephemeral attention signal |

## semiont.job

| Method | Return | Description |
|---|---|---|
| `status(jobId)` | `Promise<JobStatusResponse>` | Get job status |
| `pollUntilComplete(jobId, opts?)` | `Promise<JobStatusResponse>` | Poll until done |
| `cancel(jobId, type)` | `Promise<void>` | Cancel job (not yet implemented) |

## semiont.auth

| Method | Return | Description |
|---|---|---|
| `password(email, password)` | `Promise<AuthResponse>` | Password authentication |
| `google(credential)` | `Promise<AuthResponse>` | Google OAuth |
| `refresh(token)` | `Promise<AuthResponse>` | Refresh token |
| `logout()` | `Promise<void>` | Logout |
| `me()` | `Promise<User>` | Current user |
| `acceptTerms()` | `Promise<void>` | Accept terms |
| `mcpToken()` | `Promise<{ token }>` | Generate MCP token |
| `mediaToken(rid)` | `Promise<{ token }>` | Generate media token |

## semiont.admin

| Method | Return | Description |
|---|---|---|
| `users()` | `Promise<User[]>` | List users |
| `userStats()` | `Promise<AdminUserStatsResponse>` | User statistics |
| `updateUser(uid, data)` | `Promise<User>` | Update user |
| `oauthConfig()` | `Promise<OAuthConfigResponse>` | OAuth config |
| `healthCheck()` | `Promise<HealthResponse>` | System health |
| `status()` | `Promise<StatusResponse>` | System status |
| `backup()` | `Promise<Response>` | Backup knowledge base |
| `restore(file, onProgress?)` | `Promise<RestoreResult>` | Restore from backup |
| `exportKnowledgeBase(params?)` | `Promise<Response>` | Export as JSON-LD |
| `importKnowledgeBase(file, onProgress?)` | `Promise<ImportResult>` | Import JSON-LD |

## SSE Streams

Three long-lived broadcast streams on `semiont.sse`:

| Method | Description |
|---|---|
| `resourceEvents(rid, opts)` | Per-resource events (auto-reconnect + Last-Event-ID replay) |
| `globalEvents(opts)` | System-wide events (entity types, etc.) |
| `attentionStream(opts)` | Participant-scoped presence signals |

All return `{ close(): void }`.

## Namespace Interfaces

All interfaces are exported from `@semiont/api-client` as types:

```typescript
import type {
  BrowseNamespace,
  MarkNamespace,
  BindNamespace,
  GatherNamespace,
  MatchNamespace,
  YieldNamespace,
  BeckonNamespace,
  JobNamespace,
  AuthNamespace,
  AdminNamespace,
} from '@semiont/api-client';
```

See [namespaces/types.ts](../src/namespaces/types.ts) for the complete type definitions.
