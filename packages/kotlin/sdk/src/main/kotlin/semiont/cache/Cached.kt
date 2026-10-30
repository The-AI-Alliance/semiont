@file:OptIn(kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi::class)

package semiont.cache

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.jdk9.asPublisher
import semiont.identifiers.ResourceId
import semiont.telemetry.futureOf
import semiont.transport.ResourceHold
import semiont.transport.Transport
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Flow.Publisher

/** What a live query answers from: the namespace that made the query supplies it. */
internal interface Source<T> {
    /** The value now, from the service. */
    suspend fun fresh(): T

    /** The query's state, now and as it changes. */
    fun watch(): Flow<CacheState<T>>

    /** The value is out of date. */
    fun invalidate()

    /** A hold on the scope of the resource the query is of, when it is of one. */
    fun hold(): ResourceHold?
}

/**
 * A live query: one of a client's reads that answers from its cache and stays
 * true as the knowledge base changes. Making one touches nothing. Collected,
 * it is the live view: the query's state now and each state after it, until
 * the client is closed; collecting is what asks, and while a query of one
 * resource is collected the client holds that resource's scope, so the events
 * that keep it true reach it. A failure is a state, never a throw. `fresh` is
 * the one-shot read: it asks the service now, and gives what it answers or
 * throws the failure it met; every collector is given the answer too.
 * `invalidate` says the value is out of date: it is asked for again, and shown
 * meanwhile. Any number may collect it, each from its own start.
 */
public class Cached<T : Any> internal constructor(private val source: Source<T>, private val scope: CoroutineScope) : Flow<CacheState<T>> {
    /** The value now, from the service. */
    public suspend fun fresh(): T = source.fresh()

    /** `fresh`, for Java. */
    public fun freshFuture(): CompletableFuture<T> = scope.futureOf { fresh() }

    /** The value is out of date: ask again, showing it meanwhile. */
    public fun invalidate(): Unit = source.invalidate()

    override suspend fun collect(collector: FlowCollector<CacheState<T>>) {
        // The scope first, so the events that refresh the key are already coming when its value arrives.
        val hold = source.hold()
        try {
            source.watch().collect(collector)
        } finally {
            hold?.close()
        }
    }

    /** The query's states, for Java. */
    public fun asPublisher(): Publisher<CacheState<T>> = asFlow().asPublisher()

    private fun asFlow(): Flow<CacheState<T>> = this
}

/** A state of a cache's value, as a state of what a query shows of it. */
internal fun <V, T> CacheState<V>.shown(view: (V) -> T): CacheState<T> = when (this) {
    is CacheState.Ready -> CacheState.Ready(view(value))
    is CacheState.Pending -> this
    is CacheState.Failed -> this
}

/**
 * A query answered by one key of one cache, as `view` shows its value. `scope`
 * is the resource the query is of, over the transport whose hold on its scope
 * a collector takes.
 */
internal class Keyed<K : Any, V : Any, T>(
    private val cache: Cache<K, V>,
    private val key: K,
    private val view: (V) -> T,
    private val scope: Pair<Transport, ResourceId>? = null,
) : Source<T> {
    override suspend fun fresh(): T = view(cache.fetch(key))

    override fun watch(): Flow<CacheState<T>> = cache.observe(key).map { it.shown(view) }

    override fun invalidate(): Unit = cache.invalidate(key)

    override fun hold(): ResourceHold? = scope?.let { (transport, resourceId) -> transport.subscribeToResource(resourceId) }
}
