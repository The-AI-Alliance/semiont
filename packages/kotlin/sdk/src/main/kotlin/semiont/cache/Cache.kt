package semiont.cache

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.future.await
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import semiont.StateUnit
import semiont.Timings
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.telemetry.futureOf
import semiont.transport.Events
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.function.Function

/** Where a cache keeps its values, so a later one begins with them. */
public interface CachePersister<K : Any, V : Any> {
    /** What was kept, asked once, when the cache is built: none when nothing was. */
    public fun load(): Map<K, V>?

    /** Keep these: the cache's values, after they changed. */
    public fun save(entries: Map<K, V>)
}

/** What a read of a closed client fails as: what a request of a closed bus does. */
internal fun closed(): BusRequestError = BusRequestError(BusRequestErrorCode.Closed, "The client is closed")

/** Where the fetches of a cache a host makes run: on the default dispatcher, one failing leaving the others be. */
private fun ownScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/** One key: its state, which every observer of it holds, and the fetch in flight for it, by its number. */
private class Key<V : Any>(state: CacheState<V>) {
    /** The key's state; none once the cache is closed, which ends every observer. */
    val state = MutableStateFlow<CacheState<V>?>(state)

    /** The fetch in flight, by its number. An `invalidate` lets go of it without waiting: its answer may never come. */
    var inFlight: Pair<Int, Deferred<V>>? = null

    /** Whether anything asked for the key and has not let go of it. */
    fun known(): Boolean = inFlight != null || state.value !is CacheState.Pending
}

/**
 * A read-through cache: what a client's live queries answer from
 * (docs/protocol/CACHE-SEMANTICS.md, B1 to B20). A key has one state, and every
 * observer of the key holds it. `observe` is the live view: the first observer
 * of a key with nothing starts a fetch, later ones are given what is there, a
 * failed fetch is tried once more, and a key with a value keeps showing it
 * whatever its refetches do. `fetch` is the one-shot read: it always asks,
 * gives what it was answered or throws the failure it met, and never retries.
 * `invalidate` asks again and shows the value meanwhile; `set` writes a value
 * that is known; `remove` ends a key whose entity is gone; `close` ends every
 * observer, and nothing is fetched, retried or written after it.
 *
 * `ask` asks for a key's value, and whatever it fails with is the key's failure;
 * its fetches run in `scope`: the client's, for a cache the client makes, and one of the
 * cache's own on the default dispatcher, for one a host makes. With a
 * `persister`, the cache begins with what was kept, shows a kept value at once
 * and asks for it again the first time it is observed, and saves its values
 * once they have stopped changing for `saveDebounceMs`.
 */
public class Cache<K : Any, V : Any> internal constructor(
    private val ask: suspend (K) -> V,
    private val scope: CoroutineScope,
    private val persister: CachePersister<K, V>? = null,
    private val saveDebounceMs: Long = Timings.SAVE_DEBOUNCE_MS,
) : StateUnit {
    /** A cache of a host's own, whose fetches ask `fetch` and run on the default dispatcher. */
    public constructor(
        fetch: suspend (K) -> V,
        persister: CachePersister<K, V>? = null,
        saveDebounceMs: Long = Timings.SAVE_DEBOUNCE_MS,
    ) : this(fetch, ownScope(), persister, saveDebounceMs)

    /** A cache of a host's own, for Java: `fetch` gives a key's value as the stage it returns completes. */
    @JvmOverloads
    public constructor(
        fetch: Function<K, CompletionStage<V>>,
        persister: CachePersister<K, V>? = null,
        saveDebounceMs: Long = Timings.SAVE_DEBOUNCE_MS,
    ) : this({ key: K -> fetch.apply(key).await() }, ownScope(), persister, saveDebounceMs)

    private val lock = Any()
    private var disposed = false
    private var fetches = 0
    private var saving: Job? = null
    private val keys = LinkedHashMap<K, Key<V>>()

    /** Keys whose value an earlier cache kept and this one has not asked for. */
    private val kept = mutableSetOf<K>()

    init {
        persister?.load()?.forEach { (key, value) -> keys[key] = Key(CacheState.Ready(value)) }
        kept += keys.keys
    }

    private fun held(key: K): Key<V> = keys.getOrPut(key) { Key(CacheState.Pending) }

    private fun values(): Map<K, V> = keys.mapNotNull { (key, held) -> (held.state.value as? CacheState.Ready)?.let { key to it.value } }.toMap()

    /** The values changed: save them once they have stopped changing. Called under the lock. */
    private fun oweASave() {
        val keeping = persister ?: return
        saving?.cancel()
        saving = scope.launch {
            delay(saveDebounceMs)
            val entries = synchronized(lock) {
                saving = null
                values()
            }
            keeping.save(entries)
        }
    }

    /**
     * Start a fetch for `key`, or join the one in flight. Called under the
     * lock. The fetch asks at once, in this thread, so the requests of fetches
     * started one after another are sent in that order; it is in flight before
     * it begins, so one that ends at once has let go of the key when it ends.
     */
    private fun fetching(key: K): Deferred<V> {
        // Asked for by this cache now, whichever path asked.
        kept -= key
        val held = held(key)
        held.inFlight?.let { return it.second }
        fetches += 1
        val number = fetches
        val answer = CompletableDeferred<V>()
        held.inFlight = number to answer
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                answer.complete(fetched(key, number))
            } catch (failure: Throwable) {
                // A fetch the client's closing ended is cancelled for whoever waits on it, who is then told the client closed.
                if (failure is CancellationException) answer.cancel(failure) else answer.completeExceptionally(failure)
                if (failure is CancellationException) throw failure
            }
        }
        return answer
    }

    private suspend fun fetched(key: K, number: Int): V {
        val value = try {
            ask(key)
        } finally {
            // Only its own, and on every way out: an `invalidate` may have put a newer fetch in its place.
            synchronized(lock) {
                val held = keys[key]
                if (held != null && held.inFlight?.first == number) held.inFlight = null
            }
        }
        // A value from any fetch is written, the newest last: each is at least as new as what was there. A failure writes
        // nothing. One answered after the cache was closed has no key to write to.
        synchronized(lock) {
            keys[key]?.let {
                it.state.value = CacheState.Ready(value)
                oweASave()
            }
        }
        return value
    }

    /** What a fetch gives, to one of those waiting on it: whoever stops waiting does not stop the fetch. */
    private suspend fun joined(fetch: Deferred<V>): V = try {
        fetch.await()
    } catch (cancelled: CancellationException) {
        // The fetch was ended by its client's closing, and its caller was not: that is a failure to hear, not a cancellation.
        if (currentCoroutineContext().isActive && fetch.isCancelled) throw closed()
        throw cancelled
    }

    /**
     * Fetch for the live view: a failure is tried once more, and a key with no value whose retry also fails becomes failed.
     * Whatever a fetch failed with is a failure; a cancellation is not one. Called under the lock.
     */
    private fun revalidate(key: K) {
        val first = fetching(key)
        scope.launch {
            try {
                joined(first)
                return@launch
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Tried once more, below.
            }
            val again = synchronized(lock) { if (disposed) null else fetching(key) } ?: return@launch
            try {
                joined(again)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                synchronized(lock) {
                    val held = keys[key]
                    if (held != null && held.state.value !is CacheState.Ready) held.state.value = CacheState.Failed(failure)
                }
            }
        }
    }

    /**
     * The key's state, now and as it changes, until the cache is closed.
     * Observing is what asks: a key with nothing is fetched, a failed key is
     * tried again, and a value an earlier cache kept is asked for anew while it
     * is shown.
     */
    public fun observe(key: K): Events<CacheState<V>> = synchronized(lock) {
        if (disposed) return Events(emptyFlow()) {}
        val wasKept = key in kept
        val held = held(key)
        val asks = when (held.state.value) {
            // An observer arriving at a failed key starts over, for everyone: a fetch is in flight for all of them.
            is CacheState.Failed -> {
                held.state.value = CacheState.Pending
                true
            }
            is CacheState.Ready -> wasKept
            else -> held.inFlight == null
        }
        if (asks) revalidate(key)
        Events(
            held.state.transformWhile { state ->
                if (state != null) emit(state)
                state != null
            },
        ) {}
    }

    /**
     * Ask for the key's value now: what the service answers, which every
     * observer of the key is given too, or the failure, which only this caller
     * is. Concurrent asks for one key share one fetch.
     */
    public suspend fun fetch(key: K): V {
        val caller = currentCoroutineContext()
        val fetch = synchronized(lock) {
            if (disposed) {
                // A caller that has stopped waiting is not told the client closed: its end is its own, as in `joined`.
                caller.ensureActive()
                throw closed()
            }
            fetching(key)
        }
        return joined(fetch)
    }

    /** `fetch`, for Java. */
    public fun fetchFuture(key: K): CompletableFuture<V> = scope.futureOf { fetch(key) }

    /** The key's value now, asking for nothing. */
    public fun get(key: K): V? = synchronized(lock) { (keys[key]?.state?.value as? CacheState.Ready)?.value }

    /** Whether anything has asked for the key and not let go of it: it has a value or a failure, or a fetch for it is in flight. */
    public fun known(key: K): Boolean = synchronized(lock) { keys[key]?.known() == true }

    /** Every key the cache knows. */
    public fun keys(): List<K> = synchronized(lock) { keys.filterValues { it.known() }.keys.toList() }

    /** Whether a cache that keeps its values has not yet kept what it knows: a fetch is in flight, or a save is owed. */
    public val persistencePending: Boolean
        get() = synchronized(lock) { persister != null && (saving != null || keys.values.any { it.inFlight != null }) }

    /** The key's value is out of date: ask again, showing what there is meanwhile. A fetch in flight is not waited on. */
    public fun invalidate(key: K): Unit = synchronized(lock) {
        if (disposed) return
        val held = held(key)
        held.inFlight = null
        if (held.state.value is CacheState.Failed) held.state.value = CacheState.Pending
        revalidate(key)
    }

    /** `invalidate`, of every key the cache knows. */
    public fun invalidateAll(): Unit = keys().forEach(::invalidate)

    /** The key's entity is gone: its value is dropped and the key fails with `gone`, at once, for every observer. Nothing is asked for. */
    public fun remove(key: K, gone: Exception): Unit = synchronized(lock) {
        if (disposed) return
        val held = held(key)
        held.inFlight = null
        held.state.value = CacheState.Failed(gone)
        oweASave()
    }

    /** The key's value is known: write it, asking for nothing. */
    public fun set(key: K, value: V): Unit = synchronized(lock) {
        if (disposed) return
        kept -= key
        held(key).state.value = CacheState.Ready(value)
        oweASave()
    }

    /** End the cache: a save that was owed is made now, every observer's states end, and nothing is fetched or written after. Closing twice is closing once. */
    override fun close() {
        val (owed, ended) = synchronized(lock) {
            val owed = saving?.let {
                it.cancel()
                saving = null
                values()
            }
            disposed = true
            val ended = keys.values.toList()
            keys.clear()
            kept.clear()
            owed to ended
        }
        owed?.let { persister?.save(it) }
        ended.forEach { it.state.value = null }
    }
}
