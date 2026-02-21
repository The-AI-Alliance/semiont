/**
 * @semiont/api-client
 *
 * Complete SDK for Semiont - types, client, and utilities
 *
 * This package provides:
 * - TypeScript types generated from the OpenAPI specification
 * - A SemiontApiClient class for making API requests
 * - Utilities for working with annotations, events, and text
 *
 * Example:
 * ```typescript
 * import { SemiontApiClient, isReference, getExactText } from '@semiont/api-client';
 *
 * const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });
 * await client.authenticateLocal('user@example.com', '123456');
 *
 * const doc = await client.createResource({
 *   name: 'My Resource',
 *   content: 'Hello World',
 *   format: 'text/plain',
 *   entityTypes: ['example']
 * });
 *
 * // Use utilities
 * if (isReference(annotation)) {
 *   const text = getExactText(annotation.target.selector);
 * }
 * ```
 */

// Re-export OpenAPI types from @semiont/core (source of truth)
export type { components, paths, operations } from '@semiont/core';

// Export client
export * from './client';

// Logger interface for observability
export type { Logger } from './logger';

// Export specific types for generation context
import type { components } from '@semiont/core';
export type GenerationContext = components['schemas']['GenerationContext'];
export type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];

// SSE streaming types and client
export type {
  ReferenceDetectionProgress,
  GenerationProgress,
  SSEStream
} from './sse/types';
export { SSEClient } from './sse/index';
export type {
  DetectReferencesStreamRequest,
  GenerateResourceStreamRequest,
  SSEClientConfig
} from './sse/index';

// Handwritten utilities
export * from './utils/index';
export {
  getExtensionForMimeType,
  isImageMimeType,
  isTextMimeType,
  isPdfMimeType,
  getMimeCategory,
  type MimeCategory
} from './mime-utils';

// Re-export branded types from @semiont/core
export type {
  Motivation,
  ContentFormat,
  Email,
  AuthCode,
  GoogleCredential,
  AccessToken,
  RefreshToken,
  MCPToken,
  CloneToken,
  JobId,
  UserDID,
  EntityType,
  SearchQuery,
  BaseUrl,
  ResourceUri,
  AnnotationUri,
  ResourceAnnotationUri,
} from '@semiont/core';
export {
  email,
  authCode,
  googleCredential,
  accessToken,
  refreshToken,
  mcpToken,
  cloneToken,
  jobId,
  userDID,
  entityType,
  searchQuery,
  baseUrl,
  resourceUri,
  annotationUri,
  resourceAnnotationUri,
} from '@semiont/core';
