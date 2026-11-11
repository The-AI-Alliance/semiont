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
import kotlin.coroutines.CoroutineContext

/** Where a cache keeps its values, so a later one begins with them. */
public interface CachePersister<K : Any, V : Any> {
    /** What was kept, asked once, when the cache is given this persister: none when nothing was. */
    public fun load(): Map<K, V>?

    /** Keep these: the cache's values, after they changed. */
    public fun save(entries: Map<K, V>)
}

/** What a read of a closed client fails as: what a request of a closed bus does. */
internal fun closed(): BusRequestError = BusRequestError(BusRequestErrorCode.Closed, "The client is closed")

/** Where the fetches of a cache a host makes run: on `context`, under the job it has when it has one, one failing leaving the others be. */
private fun ownScope(context: CoroutineContext): CoroutineScope = CoroutineScope(context + SupervisorJob(context[Job]))

/** One key: its state, which every observer of it holds, and the fetch in flight for it, by its number. */
private class Key<V : Any>(state: CacheState<V>) {
    /** The key's state; none once the cache is closed, which ends every observer. */
    val state = MutableStateFlow<CacheState<V>?>(state)

    /** The fetch in flight, by its number. An `invalidate` lets go of it without waiting: its answer may never come. */
    var inFlight: Pair<Int, Deferred<Result<V>>>? = null

    /** The number of the fetch the live view waits on, and whether it is the view's second ask. */
    var validation: Int? = null
    var revalidated = false

    /** Whether anything asked for the key and has not let go of it. */
    fun known(): Boolean = inFlight != null || state.value !is CacheState.Pending
}

/**
 * A read-through cache: what a client's live queries answer from
 * (protocol/contract/CACHE-SEMANTICS.md, B1 to B20). A key has one state, and every
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
 * cache's own on the context it is given, for one a host makes. With a
 * `persister`, the cache begins with what was kept, shows a kept value at once
 * and asks for it again the first time it is observed, and saves its values
 * once they have stopped changing for `saveDebounceMs`. A save the persister
 * refuses (it throws) is owed still: the cache's next change, or its closing,
 * saves them again. One a client gives its persister later (`attach`) does the
 * same from then on.
 */
public class Cache<K : Any, V : Any> internal constructor(
    private val ask: suspend (K) -> V,
    private val scope: CoroutineScope,
    persister: CachePersister<K, V>? = null,
    private val saveDebounceMs: Long = Timings.SAVE_DEBOUNCE_MS,
) : StateUnit {
    /** A cache of a host's own, whose fetches ask `fetch` and run, and whose save debounce waits, on `context`. */
    public constructor(
        fetch: suspend (K) -> V,
        persister: CachePersister<K, V>? = null,
        saveDebounceMs: Long = Timings.SAVE_DEBOUNCE_MS,
        context: CoroutineContext = Dispatchers.Default,
    ) : this(fetch, ownScope(context), persister, saveDebounceMs)

    /** A cache of a host's own, for Java: `fetch` gives a key's value as the stage it returns completes. */
    @JvmOverloads
    public constructor(
        fetch: Function<K, CompletionStage<V>>,
        persister: CachePersister<K, V>? = null,
        saveDebounceMs: Long = Timings.SAVE_DEBOUNCE_MS,
        context: CoroutineContext = Dispatchers.Default,
    ) : this({ key: K -> fetch.apply(key).await() }, ownScope(context), persister, saveDebounceMs)

    private val lock = Any()
    private var keeping: CachePersister<K, V>? = null
    private var disposed = false
    private var fetches = 0

    /** Whether the values changed since the persister last took them: a save waits for them to stop changing, or the persister refused the last. */
    private var owed = false

    /** The wait for the values to stop changing, once they have changed, before they are saved. */
    private var saving: Job? = null
    private val keys = LinkedHashMap<K, Key<V>>()

    /** Keys whose value an earlier cache kept and this one has not asked for. */
    private val kept = mutableSetOf<K>()

    init {
        if (persister != null) attach(persister)
    }

    /**
     * Keep the cache's values with `persister` from now on, beginning with what
     * it kept: a kept value fills only a key the cache holds nothing for, is
     * shown at once, and is asked for anew the first time it is observed. What
     * the cache holds is saved there from its next change. A closed cache, and
     * one that keeps its values already, are left as they are.
     */
    internal fun attach(persister: CachePersister<K, V>): Unit = synchronized(lock) {
        if (disposed || keeping != null) return
        keeping = persister
        persister.load()?.forEach { (key, value) ->
            if (keys[key]?.known() != true) {
                held(key).state.value = CacheState.Ready(value)
                kept += key
            }
        }
    }

    private fun held(key: K): Key<V> = keys.getOrPut(key) { Key(CacheState.Pending) }

    private fun values(): Map<K, V> = keys.mapNotNull { (key, held) -> (held.state.value as? CacheState.Ready)?.let { key to it.value } }.toMap()

    /** The values changed: save them once they have stopped changing. A save the persister refuses stays owed, for the next change or the closing to save. Called under the lock. */
    private fun oweASave() {
        val persister = keeping ?: return
        owed = true
        saving?.cancel()
        saving = scope.launch {
            delay(saveDebounceMs)
            val entries = synchronized(lock) {
                saving = null
                owed = false
                values()
            }
            try {
                persister.save(entries)
            } catch (refused: Exception) {
                synchronized(lock) { if (!disposed) owed = true }
                throw refused
            }
        }
    }

    /**
     * Start a fetch for `key`, or join the one in flight. Called under the
     * lock. The fetch asks at once, in this thread, so the requests of fetches
     * started one after another are sent in that order; it is in flight before
     * it begins, so one that ends at once has let go of the key when it ends.
     * Its failure is handed on as a value, so each waiter is given the very
     * failure the fetch met, not the copy an awaited failure is rethrown as
     * when the coroutine library recovers its stack trace. A fetch the live
     * view is `validating` is the one its validation waits on, named before
     * the fetch begins, as one that ends at once settles before this returns.
     */
    private fun fetching(key: K, validating: Boolean): Deferred<Result<V>> {
        // Asked for by this cache now, whichever path asked.
        kept -= key
        val held = held(key)
        held.inFlight?.let {
            if (validating) held.validation = it.first
            return it.second
        }
        fetches += 1
        val number = fetches
        val answer = CompletableDeferred<Result<V>>()
        held.inFlight = number to answer
        if (validating) held.validation = number
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                answer.complete(Result.success(fetched(key, number)))
            } catch (cancelled: CancellationException) {
                // A fetch the client's closing ended is cancelled for whoever waits on it, who is then told the client closed.
                answer.cancel(cancelled)
                throw cancelled
            } catch (failure: Throwable) {
                answer.complete(Result.failure(failure))
            }
        }
        return answer
    }

    private suspend fun fetched(key: K, number: Int): V {
        val value = try {
            ask(key)
        } catch (failure: Throwable) {
            synchronized(lock) { current(key, number)?.let { settled(key, it, number, failure) } }
            throw failure
        }
        // Only the key's current fetch writes (B9). One an `invalidate` or a `remove` let go of, or one answered after the
        // cache was closed, answers whoever waited on it, and stores nothing. A failure writes nothing.
        synchronized(lock) {
            current(key, number)?.let {
                it.state.value = CacheState.Ready(value)
                oweASave()
                settled(key, it, number, null)
            }
        }
        return value
    }

    /** The key `key`, while fetch `number` is the fetch in flight for it. Called under the lock. */
    private fun current(key: K, number: Int): Key<V>? = keys[key]?.takeIf { it.inFlight?.first == number }

    /**
     * Fetch `number`, `key`'s current fetch, has settled, with `failure` or
     * with its value written and its save owed: the key lets go of it, and the
     * live view's validation waiting on it ends, in this one step. So a key
     * whose fetch has settled is not fetching, and one whose fetch is not
     * settled is (protocol/contract/CACHE-SEMANTICS.md B17's "in flight"); and
     * the retry a first failure owes is in flight in the step that failure
     * settles in. A second ask that fails fails a key that holds no value.
     * Called under the lock.
     */
    private fun settled(key: K, held: Key<V>, number: Int, failure: Throwable?) {
        held.inFlight = null
        if (held.validation != number) return
        held.validation = null
        if (failure !is Exception || failure is CancellationException) return
        if (!held.revalidated) {
            held.revalidated = true
            fetching(key, validating = true)
        } else if (held.state.value !is CacheState.Ready) {
            held.state.value = CacheState.Failed(failure)
        }
    }

    /** What a fetch gives, to one of those waiting on it: whoever stops waiting does not stop the fetch. */
    private suspend fun joined(fetch: Deferred<Result<V>>): V {
        val given = try {
            fetch.await()
        } catch (cancelled: CancellationException) {
            // The fetch was ended by its client's closing, and its caller was not: that is a failure to hear, not a cancellation.
            if (currentCoroutineContext().isActive && fetch.isCancelled) throw closed()
            throw cancelled
        }
        return given.getOrThrow()
    }

    /**
     * Fetch for the live view: a failure is tried once more, and a key with no value whose retry also fails becomes failed
     * (`settled`). Whatever a fetch failed with is a failure; a cancellation is not one. Called under the lock.
     */
    private fun revalidate(key: K) {
        held(key).revalidated = false
        fetching(key, validating = true)
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
            fetching(key, validating = false)
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
        get() = synchronized(lock) { keeping != null && (owed || fetchInFlight()) }

    /** Whether a cache that keeps its values has a fetch in flight: what closing it drops. */
    internal val keptFetchInFlight: Boolean
        get() = synchronized(lock) { keeping != null && fetchInFlight() }

    /** Called under the lock. */
    private fun fetchInFlight(): Boolean = keys.values.any { it.inFlight != null }

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

    /** End the cache: a save that was owed, or refused, is made now, every observer's states end, and nothing is fetched or written after. Closing twice is closing once. */
    override fun close() {
        val (unsaved, ended) = synchronized(lock) {
            saving?.cancel()
            saving = null
            val unsaved = if (owed) values() else null
            owed = false
            disposed = true
            val ended = keys.values.toList()
            keys.clear()
            kept.clear()
            unsaved to ended
        }
        unsaved?.let { keeping?.save(it) }
        ended.forEach { it.state.value = null }
    }
}
