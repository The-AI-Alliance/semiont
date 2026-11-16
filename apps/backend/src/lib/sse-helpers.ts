/**
 * Type-safe SSE helpers
 *
 * Enforces that all SSE event names are defined in Event Map (@semiont/core)
 * AND that payloads match the declared shape for each event.
 */

import type { EventName, EventMap } from '@semiont/core';
import type { SSEStreamingApi } from 'hono/streaming';

/**
 * Write a type-safe SSE event
 *
 * Ensures event names are defined in Event Map at compile-time AND that
 * the payload matches the declared shape for that event name.
 * Serializes `data` to JSON internally — callers pass typed objects, not strings.
 *
 * @param stream - Hono SSE stream
 * @param options - Event options with type-checked event name and payload
 *
 * @example
 * ```typescript
 * await writeTypedSSE(stream, {
 *   event: 'generation:complete',  // ✅ Valid event from Event Map
 *   data: { ... },                 // ✅ TypeScript checks shape matches EventMap['generation:complete']
 *   id: String(Date.now())
 * });
 *
 * await writeTypedSSE(stream, {
 *   event: 'generation-error',  // ❌ TypeScript error - not in Event Map!
 *   data: { ... }
 * });
 * ```
 */
export async function writeTypedSSE<TEvent extends EventName>(
  stream: SSEStreamingApi,
  options: {
    /** Event name - must be defined in Event Map */
    event: TEvent;
    /** Event payload - must match EventMap[TEvent] */
    data: EventMap[TEvent];
    /** Optional event ID */
    id?: string;
  }
): Promise<void> {
  await stream.writeSSE({
    event: options.event,
    data: JSON.stringify(options.data),
    id: options.id
  });
}
