/**
 * Type-safe SSE helpers
 *
 * Enforces that all SSE event names are defined in Event Map (@semiont/core)
 */

import type { EventName } from '@semiont/core';
import type { SSEStreamingApi } from 'hono/streaming';

/**
 * Write a type-safe SSE event
 *
 * Ensures event names are defined in Event Map at compile-time.
 *
 * @param stream - Hono SSE stream
 * @param options - Event options with type-checked event name
 *
 * @example
 * ```typescript
 * await writeTypedSSE(stream, {
 *   event: 'generation:complete',  // ✅ Valid event from Event Map
 *   data: JSON.stringify(progress),
 *   id: String(Date.now())
 * });
 *
 * await writeTypedSSE(stream, {
 *   event: 'generation-error',  // ❌ TypeScript error - not in Event Map!
 *   data: '...'
 * });
 * ```
 */
export async function writeTypedSSE(
  stream: SSEStreamingApi,
  options: {
    /** Event name - must be defined in Event Map */
    event: EventName;
    /** Event data (usually JSON stringified) */
    data: string;
    /** Optional event ID */
    id?: string;
  }
): Promise<void> {
  await stream.writeSSE({
    event: options.event,
    data: options.data,
    id: options.id
  });
}
