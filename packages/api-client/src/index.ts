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

// Handwritten utilities
export * from './utils';
