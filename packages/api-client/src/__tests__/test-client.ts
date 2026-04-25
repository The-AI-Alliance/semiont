/**
 * makeTestClient — structurally-typed `SemiontClient` stand-in for VM
 * factory tests. Exposes a real `EventBus` as `client.bus` (the same
 * shape production code reads), plus whatever HTTP namespaces the caller
 * supplies via `overrides`.
 *
 * Usage:
 *
 * ```ts
 * // bus-only VM
 * const { bus, client } = makeTestClient();
 * const vm = createShellVM(client);
 * client.bus.get('panel:toggle').next({ panel: 'annotations' });
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
 * The `client` is cast `as unknown as SemiontClient`, matching the
 * established pattern for structural mocks in this codebase.
 */

import { EventBus } from '@semiont/core';
import type { SemiontClient } from '../client';

export interface TestClient {
  /** The real bus backing `client.bus` — exposed so tests can
   *  destroy() it in afterEach. Same instance as `client.bus`. */
  bus: EventBus;
  client: SemiontClient;
}

export function makeTestClient(
  overrides: Record<string, unknown> = {},
): TestClient {
  const bus = new EventBus();
  const client = {
    ...overrides,
    bus,
  } as unknown as SemiontClient;
  return { bus, client };
}
