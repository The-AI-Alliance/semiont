/**
 * Adaptive burst buffer RxJS operator.
 *
 * Passes the first event through immediately (zero latency for interactive use).
 * If more events arrive within the burst window, switches to accumulate mode
 * and flushes batches. Returns to passthrough mode after an idle period.
 *
 * Emits individual items (T) in passthrough mode and arrays (T[]) in batch mode.
 * Consumers distinguish via Array.isArray().
 *
 * Threshold tuning:
 *   burstWindowMs  — How long to wait for more events before flushing a batch.
 *                    50ms is a good default: longer than event-loop jitter (~1-5ms)
 *                    but short enough to feel responsive.
 *   maxBatchSize   — Force-flush at this size to bound memory. 500 is safe for
 *                    Neo4j UNWIND queries. Increase if graph writes are cheap.
 *   idleTimeoutMs  — How long after the last flush before returning to passthrough.
 *                    200ms is a good default. Must be >= burstWindowMs.
 *
 * See: packages/graph/docs/ARCHITECTURE.md for Weaver context.
 */
import { OperatorFunction } from 'rxjs';
export interface BurstBufferOptions {
    /**
     * Time window (ms) to detect burst activity after an event.
     * If another event arrives within this window, it is buffered.
     * The buffer flushes when no new event arrives for this duration (debounce).
     *
     * Recommended: 50ms.
     */
    burstWindowMs: number;
    /**
     * Maximum events to accumulate before forcing a flush.
     * Prevents unbounded memory growth during sustained bursts.
     *
     * Recommended: 500.
     */
    maxBatchSize: number;
    /**
     * Time (ms) of silence after the last flush before returning to passthrough mode.
     * The next event after this timeout emits immediately (leading edge).
     * Must be >= burstWindowMs.
     *
     * Recommended: 200ms.
     */
    idleTimeoutMs: number;
}
/**
 * Adaptive burst buffer operator.
 *
 * State machine:
 *   PASSTHROUGH → event arrives → emit immediately, transition to ACCUMULATING
 *   ACCUMULATING → event arrives → buffer it, reset burst timer
 *   ACCUMULATING → burst timer fires (no new events for burstWindowMs) → flush buffer as T[]
 *   ACCUMULATING → buffer reaches maxBatchSize → flush buffer as T[]
 *   After flush → idle timer starts
 *   Idle timer fires (no new events for idleTimeoutMs) → transition to PASSTHROUGH
 */
export declare function burstBuffer<T>(options: BurstBufferOptions): OperatorFunction<T, T | T[]>;
