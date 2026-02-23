/**
 * @semiont/api-client
 *
 * HTTP client and utilities for the Semiont API
 *
 * This package provides:
 * - A SemiontApiClient class for making API requests
 * - SSE streaming client
 * - Utilities for working with annotations and text
 *
 * For OpenAPI types and branded types, import from @semiont/core:
 * ```typescript
 * import type { components } from '@semiont/core';
 * import { resourceUri, accessToken } from '@semiont/core';
 * import { SemiontApiClient } from '@semiont/api-client';
 *
 * const client = new SemiontApiClient({ baseUrl: baseUrl('http://localhost:4000') });
 * const token = accessToken('your-token');
 * const rUri = resourceUri('http://localhost:4000/resources/doc-123');
 * ```
 */

// Export client
export * from './client';

// Logger interface for observability
export type { Logger } from './logger';

// SSE streaming types and client
export type {
  ReferenceDetectionProgress,
  GenerationProgress,
  SSEStream
} from './sse/types';
export { SSEClient, SSE_STREAM_CONNECTED } from './sse/index';
export type {
  DetectReferencesStreamRequest,
  GenerateResourceStreamRequest,
  SSEClientConfig,
  SSEStreamConnected
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
