/**
 * makeTestClient — structurally-typed `SemiontApiClient` stand-in for VM
 * factory tests. Implements the bus surface (`emit` / `on` / `stream`)
 * backed by a real `EventBus` the test retains access to, plus whatever
 * HTTP namespaces the caller supplies via `overrides`.
 *
 * Usage:
 *
 * ```ts
 * // bus-only VM
 * const { bus, client } = makeTestClient();
 * const vm = createShellVM(client);
 * client.emit('panel:toggle', { panel: 'annotations' });
 * bus.destroy(); // in afterEach
 *
 * // VM that also calls HTTP namespaces
 * const { client } = makeTestClient({
 *   mark: {
 *     annotation: vi.fn().mockResolvedValue({ annotationId: 'ann-new' }),
 *     delete: vi.fn().mockResolvedValue(undefined),
 *   },
 * });
 * const vm = createMarkVM(client, resourceId);
 * ```
 *
 * The `client` is cast `as unknown as SemiontApiClient`, matching the
 * established pattern for structural mocks in this codebase (see earlier
 * bespoke `mockClient()` helpers in mark-vm.test.ts etc. — all of which
 * should migrate to this shared helper).
 */

import { EventBus, type EventMap } from '@semiont/core';
import type { Observable } from 'rxjs';
import type { SemiontApiClient } from '../client';

export interface TestClient {
  /** The real bus backing emit/on/stream — exposed so tests can
   *  destroy() it in afterEach and, if needed, inspect raw subjects. */
  bus: EventBus;
  client: SemiontApiClient;
}

export function makeTestClient(
  overrides: Record<string, unknown> = {},
): TestClient {
  const bus = new EventBus();
  const client = {
    ...overrides,
    emit: <K extends keyof EventMap>(ch: K, p: EventMap[K]) => bus.get(ch).next(p),
    on: <K extends keyof EventMap>(ch: K, h: (p: EventMap[K]) => void) => {
      const sub = bus.get(ch).subscribe(h);
      return () => sub.unsubscribe();
    },
    stream: <K extends keyof EventMap>(ch: K): Observable<EventMap[K]> =>
      bus.get(ch).asObservable(),
  } as unknown as SemiontApiClient;
  return { bus, client };
}
