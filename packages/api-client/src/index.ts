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

// Generated OpenAPI types and client
export * from './types';
export * from './client';
export type { components } from './types';
import type { components } from './types';

// Logger interface for observability
export type { Logger } from './logger';

// Export specific types for generation context
export type GenerationContext = components['schemas']['GenerationContext'];
export type AnnotationLLMContextResponse = components['schemas']['AnnotationLLMContextResponse'];

// SSE streaming types and client
export type {
  DetectionProgress,
  GenerationProgress,
  ResourceEvent,
  SSEStream
} from './sse/types';
export { SSEClient } from './sse/index';
export type {
  DetectAnnotationsStreamRequest,
  GenerateResourceStreamRequest,
  SSEClientConfig
} from './sse/index';

// Handwritten utilities
export * from './utils/index';
export {
  getExtensionForMimeType,
  isImageMimeType,
  isTextMimeType,
  getMimeCategory,
  type MimeCategory
} from './mime-utils';

// All branded types (URIs, tokens, identifiers, etc.)
export * from './branded-types';
