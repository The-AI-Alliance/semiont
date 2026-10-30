@file:OptIn(kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi::class)

package semiont

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.isActive
import kotlinx.coroutines.jdk9.asPublisher
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.telemetry.futureOf
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Flow.Publisher

/**
 * A long-running operation: what it reports as it goes, then its final value.
 * It is consumed one way, once: awaited, it gives the final value; collected,
 * it gives every report and then the final value, and ends, a failure thrown
 * where the final value would have been given. Nothing is sent until it is
 * first awaited or collected. Its caller abandons it by cancelling what awaits
 * or collects it: what was sent stays sent, and nothing more is.
 */
public class Running<T : Any> internal constructor(
    private val scope: CoroutineScope,
    private val start: suspend (report: (T) -> Unit) -> T,
) : Flow<T> {
    private val reports = Channel<T>(Channel.UNLIMITED)
    private var working: Deferred<T>? = null
    private var taken = false

    private fun begun(): Deferred<T> = synchronized(this) {
        working ?: scope.async {
            try {
                start { reports.trySend(it) }
            } finally {
                // What it reported before it ended has been queued, and it reports no more.
                reports.close()
            }
        }.also { working = it }
    }

    private fun take() = synchronized(this) {
        check(!taken) { "a running operation is awaited or read once" }
        taken = true
    }

    /** The work's outcome. Abandoned, the work is ended; ended by its client's closing, it fails as `bus.closed`. */
    private suspend fun outcome(): T {
        val work = begun()
        try {
            return work.await()
        } catch (cancelled: CancellationException) {
            if (currentCoroutineContext().isActive && work.isCancelled) {
                throw BusRequestError(BusRequestErrorCode.Closed, "The client closed before the operation ended")
            }
            work.cancel()
            throw cancelled
        }
    }

    /** The final value. */
    public suspend fun await(): T {
        take()
        return outcome()
    }

    /** `await`, for Java: cancelling the future abandons the operation. */
    public fun awaitFuture(): CompletableFuture<T> {
        take()
        return scope.futureOf { outcome() }
    }

    override suspend fun collect(collector: FlowCollector<T>) {
        take()
        val work = begun()
        try {
            for (report in reports) collector.emit(report)
        } catch (cancelled: CancellationException) {
            work.cancel()
            throw cancelled
        }
        // Every report has been given: the work's outcome is the last item.
        collector.emit(outcome())
    }

    /** Every report and then the final value, for Java. */
    public fun asPublisher(): Publisher<T> = asFlow().asPublisher()

    private fun asFlow(): Flow<T> = this
}
