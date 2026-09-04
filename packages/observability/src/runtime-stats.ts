/**
 * Process-runtime readings (ARCHIVIST-STAYS-UP P4).
 *
 * Node-only, and deliberately a plain function rather than a gauge callback:
 * the numbers are the thing worth testing, and a callback registered inside
 * an SDK is awkward to assert against.
 *
 * **Why `heapLimit` is the field that matters.** The Archivist died at
 * ~1016 MB inside a 2048 MB container (`bugs/absent-archivist-wedges-browse.md`)
 * — not because it exhausted the container, but because it hit V8's OWN
 * default old-space ceiling, which is derived from visible memory and lands
 * well under it. `heapUsed` alone cannot express "how close to death is
 * this"; only the pair can. It is also how a configured
 * `--max-old-space-size` is verified to have taken effect, rather than
 * assumed from the fact that someone set an env var.
 */

import { getHeapStatistics } from 'node:v8';

export interface HeapStats {
  /** Live heap in use. */
  heapUsed: number;
  /** Heap V8 has currently reserved. */
  heapTotal: number;
  /** The ceiling V8 will die at — NOT the container's limit. */
  heapLimit: number;
  /** Resident set: everything, including buffers outside the JS heap. */
  rss: number;
}

export function heapStats(): HeapStats {
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    heapLimit: getHeapStatistics().heap_size_limit,
    rss: mem.rss,
  };
}
