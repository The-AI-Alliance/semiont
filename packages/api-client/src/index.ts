/**
 * @semiont/api-client
 *
 * Generated API client for Semiont backend
 *
 * This package provides:
 * - TypeScript types generated from the OpenAPI specification
 * - A common SemiontApiClient class for making API requests
 *
 * Example:
 * ```typescript
 * import { SemiontApiClient } from '@semiont/api-client';
 *
 * const client = new SemiontApiClient({ baseUrl: 'http://localhost:4000' });
 * await client.authenticateLocal('user@example.com', '123456');
 *
 * const doc = await client.createDocument({
 *   name: 'My Document',
 *   content: 'Hello World',
 *   format: 'text/plain',
 *   entityTypes: ['example']
 * });
 * ```
 */

export * from './types';
export * from './client';
