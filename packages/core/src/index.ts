/**
 * @semiont/core
 *
 * Core domain logic and utilities for the Semiont semantic knowledge platform.
 * OpenAPI types are generated here and exported for use across the monorepo.
 */

// OpenAPI-generated types (source of truth for API schemas)
export type { components, paths, operations } from './types';

// Branded types (compile-time type safety)
export type {
  // OpenAPI types
  Motivation,
  ContentFormat,
  // Authentication & tokens
  AccessToken,
  // System identifiers
  EntityType,
  BaseUrl,
} from './branded-types';
export {
  // Helper functions
  accessToken,
  entityType,
  baseUrl,
} from './branded-types';

// The kinds of id, generated from the spec
export type { ResourceId, AnnotationId, JobId, UserId } from './identifiers';
export {
  resourceId,
  annotationId,
  jobId,
  userId,
  isResourceId,
  isAnnotationId,
  isJobId,
  isUserId,
} from './identifiers';

// Whether a job matches a filter: a claim's, or a party's own before it claims.
export { jobMatchesFilter, type FilterableJob } from './job-filter';

// Job storage names and the job-type census, generated from the spec.
export {
  JOBS_STREAM,
  JOBS_SUBJECT_ROOT,
  JOBS_STREAM_SUBJECTS,
  JOBS_CONSUMER,
  JOBS_BUCKET,
  JOB_TYPES,
  MARK_MOTIVATIONS,
  jobSubject,
} from './generated/job-storage';

// Graph types
export type { ResourceDescriptor } from './graph';

// Event base types (persistence model foundations)
export type {
  Brand,
  EventBase,
  EventMetadata,
  EventSignature,
  StoredEvent,
  EnrichedEvent,
  AttributedEvent,
  BodyOperation,
  BodyItem,
} from './event-base';

// Persisted events (the event types written to the log)
export type {
  EventOfType,
  PersistedEvent,
  PersistedEventType,
  EventInput,
} from './persisted-events';
export { PERSISTED_EVENT_TYPES } from './persisted-events';

// Bus protocol (unified EventMap — all channels on the EventBus)
export type {
  EventMap,
  EventName,
  EmittableChannel,
  AnchorRect,
} from './bus-protocol';
export { ENRICHED_EVENT_TYPES, CHANNEL_SCHEMAS, TRACE_FIELD } from './bus-protocol';
export type { EnrichedEventType } from './bus-protocol';

// Payload type aliases (OpenAPI schema shortcuts used across the codebase)
export type {
  Selector,
  GatheredContext,
  MarkJobParams,
  JobFilter,
  JobResult,
  MarkJobDone,
  YieldJobDone,
  MarkJobResult,
  YieldJobResult,
  UnitCursor,
  GenerationJobParams,
  JobType,
  CollaboratorEntry,
  Collaborator,
  KbDescription,
  DiscoveryDocument,
  DiscoveredKB,
  KbTarget,
  KnowledgeBase,
  NewKnowledgeBase,
  KbRead,
  KbEndpoint,
  HttpEndpoint,
  LocalEndpoint,
} from './payload-types';

// Event utilities
export type { StoredEventLike } from './event-utils';
export { getAnnotationIdFromEvent } from './event-utils';

// Event bus (RxJS-based, framework-agnostic)
export { EventBus, ScopedEventBus, type BusFrame, type BusEnvelope, type TraceCarrier } from './event-bus';
export { relayFrames, type FrameSource, type FrameSink } from './relay-frames';

// Which failures are worth another attempt, per context — one catalog so the
// contexts' disagreements are visible rather than distributed.
export { RETRY_RULES } from './retry-rules';
export type { RetryRule, RetryFacts } from './retry-rules';

// Logger interface (framework-agnostic)
export type { Logger } from './logger';

// Bus logging — Tier 1 cross-wire observability
export { busLog, busLogEnabled, setBusLogTraceIdProvider, type BusOp } from './bus-log';

// The annotation builders: what a worker turns a model's words into
// annotations with. Every SDK has the three, and
// specs/src/annotations/builder-cases.json holds them to one answer.
export { reconcile, annotationOfSpan, annotationOfResource, SpanRefusedError } from './annotation-builders';
export type { QuotedText, TextSpan, ReconciledSpan, AnchorMethod } from './annotation-builders';

// W3C Web Annotation accessors (target/body/selector helpers + type guards)
export {
  getTextPositionSelector,
  getSvgSelector,
  getFragmentSelector,
  getBodySource,
  isBodyResolved,
  getTargetSource,
  getTargetSelector,
  isHighlight,
  isReference,
  isAssessment,
  isComment,
  isTag,
  getCommentText,
  isStubReference,
  isResolvedReference,
  getExactText,
  getAnnotationExactText,
  getTextQuoteSelector,
  getEntityTypes,
  getTagCategory,
  getTagSchemaId,
} from './web-annotation-utils';
export type {
  TextPositionSelector,
  TextQuoteSelector,
  SvgSelector,
  FragmentSelector,
} from './web-annotation-utils';

// PDF viewrect FragmentSelector codec (peer of the W3C FragmentSelector wrapper)
export {
  createFragmentSelector,
  parseFragmentSelector,
} from './pdf-coordinates';
export type { PdfCoordinate } from './pdf-coordinates';

// PDF text <-> geometry anchoring (locate/textUnder are inverses)
export { locate, textUnder } from './pdf-anchoring';
export type { AnchoredText, AnchoredTextAnswer, PdfTextItem } from './pdf-anchoring';

// ResourceDescriptor accessors
export {
  getResourceId,
  getPrimaryRepresentation,
  getPrimaryMediaType,
  getLanguage,
  getStorageUri,
  isArchived,
  getResourceEntityTypes,
  isDraft,
  decodeRepresentation,
} from './resource-utils';

// Transport contract — interfaces every concrete transport must satisfy.
export type {
  ITransport,
  IGatewayOperations,
  IContentTransport,
  PutBinaryRequest,
  PutBinaryOptions,
  PutBinaryProgress,
  ConnectionState,
  HealthCheckResponse,
  StatusResponse,
  UserResponse,
} from './transport';

// Channel set every concrete transport bridges into the client's bus.
export {
  BRIDGED_CHANNELS,
  RESOURCE_SCOPED_CHANNELS,
  isResourceScopedChannel,
  type BridgedChannel,
  type ResourceScopedChannel,
  type UnscopedChannel,
} from './bridged-channels';

// Request/reply over the bus — the transport-neutral primitive.
export { replyChannelsFor, BusRequestError } from './bus-request';
export { Bus, type BusPrimitive, type Delivered } from './bus';
// The client's deadlines, retry budgets and stream cadence, generated from
// specs/src/client/timing.json — the table every SDK generates from.
export * from './generated/client-timing';

// What each event on the bus refreshes in a client's cache, generated from
// specs/src/client/refresh.json — the table every SDK generates from.
export * from './generated/cache-refresh';
// The client error vocabularies and their classifiers, generated from
// specs/src/errors/codes.json — the table every SDK generates from.
export {
  transportErrorCodeForStatus,
  type BusRequestErrorCode,
  type TransportErrorCode,
  type JobErrorCode,
  type SemiontSessionErrorCode,
  type SignInErrorCode,
  type IdentityUnverifiableReason,
  type SpanRefusal,
} from './generated/error-codes';
export * from './generated/oauth-clients';
export { BUS_OPERATIONS, type BusOperationKey, type BusOperationSpec } from './bus-operations';
export { LIMITS_OPERATIONS, type LimitsOperation } from './limits-operations';
export {
  CHANNEL_ATTRS,
  channelAttrsOf,
  channelWrites,
  type ChannelAttrs,
  type ChannelDelivery,
  type ChannelDirection,
} from './bus-classification';

// How well a quote was found in a text (annotation re-anchoring under content edits)
export type { MatchQuality } from './fuzzy-anchor';

// Render-time anchoring (combines position + quote selectors with scoring)
export { anchorAnnotation } from './anchor-annotation';
export type {
  AnchorStrategy,
  AnchorConfidence,
  RenderedAnchor,
  AnchorSelectors,
} from './anchor-annotation';

// Locale info table
export {
  LOCALES,
  LOCALE_CODES,
  formatLocaleDisplay,
} from './locales';
export type { LocaleCode, LocaleInfo } from './locales';

// SVG utilities
export {
  createRectangleSvg,
  createPolygonSvg,
  createCircleSvg,
  parseSvgSelector,
  scaleSvgToNative,
} from './svg-utils';
export type { Point } from './svg-utils';

// Text offsets, and the context of a span of a text
export { textOffsets, type TextOffsets } from './text-offsets';
export { extractContext } from './text-context';

// The text some bytes are, in the charset their content type states
export { decodeWithCharset } from './text-encoding';

// Schema validation helpers
export {
  JWTTokenSchema,
  validateData,
  isValidEmail,
} from './validation';
export type { ValidationSuccess, ValidationFailure, ValidationResult } from './validation';

// Media-type registry (capability-tiered, keyed by the spec's SupportedMediaType enum)
export {
  MEDIA_TYPES,
  baseMediaType,
  isSupportedMediaType,
  capabilitiesOf,
  cloneFormat,
  extensionForMediaType,
  mediaTypeForExtension,
  textSourceOf,
  yieldsGeometryOf,
  derivesTextOf,
  AUTHORABLE_MEDIA_TYPES,
  GENERATABLE_MEDIA_TYPES,
} from './media-types';
export type {
  SupportedMediaType,
  MediaTypeCapabilities,
  RenderMode,
  AnchoringModel,
  TextSource,
} from './media-types';

// Annotation types
export type { Annotation } from './annotation-types';

// Tag-schema type aliases (the schemas themselves are runtime-registered per KB)
export type { TagSchema, TagCategory } from './tag-schemas';

// ID generation
export { uuidV4 } from './id-generation';

// State-unit pattern — the disposable contract shared by every layer (sdk,
// http-transport, react-ui, …). The axiom harness lives in `@semiont/core/testing`.
export type { StateUnit } from './state-unit';
export { watched, type Watched } from './watched';

// Utility functions
export * from './storage-uri';
export * from './type-guards';
export * from './errors';
export * from './did-utils';
export * from './service-account';
export { UnansweredError, jsonOf, whyUnanswered } from './unanswered';

// Knowledge-graph view derivation — pure fn over the KnowledgeGraph type,
// run by @semiont/react-ui.
export { deriveViews } from './knowledge-graph-views';
export type { GraphViews } from './knowledge-graph-views';

// Bounded retry with backoff — startup connections from long-running peers
// to the gateway.
export { retryWithBackoff, equalJitter, isRetryableRequestError, retryAfterMs, STARTUP_FETCH_RETRY } from './retry';
export type { HttpStatusError, RetryPolicy, RetryAttemptInfo } from './retry';

// Browser ↔ launcher KB discovery — the canonical served URL of the
// launcher's discovery document.
export { DISCOVERY_URL_PATH } from './discovery';
