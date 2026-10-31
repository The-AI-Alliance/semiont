package semiont.state

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withTimeoutOrNull
import semiont.StateUnit
import semiont.Timings
import semiont.transport.Variable
import semiont.transport.Watched
import kotlin.coroutines.CoroutineContext

/** What a search shows: its results, and whether more are on their way. Written `{"results", "isSearching"}`. */
public data class SearchState<T>(
    public val results: List<T>,
    public val isSearching: Boolean,
)

/**
 * A search as it is typed: a query, and the results of the query it last
 * settled on. The query is whatever was last set. Once it has stayed the same
 * for `debounceMs`, it is searched for, unless it is the query already
 * searched for. A query of nothing but spaces searches for nothing and has no
 * results. A new query abandons the search before it. The query it begins
 * with, `initialQuery`, settles like any other.
 *
 * `search` gives a query's answers: none while the answer is on its way, the
 * results once they are known, and again each time they change. A live query
 * of the client is such a flow, once each of its states is read as one or the
 * other. A search that is abandoned has its collection cancelled. Its waits are
 * timed in `context`.
 */
public class SearchPipeline<T> internal constructor(
    private val search: (String) -> Flow<List<T>?>,
    private val debounceMs: Long,
    initialQuery: String,
    context: CoroutineContext,
) : StateUnit {
    /** A pipeline timed on the default dispatcher. */
    @JvmOverloads
    public constructor(
        search: (String) -> Flow<List<T>?>,
        debounceMs: Long = Timings.SEARCH_DEBOUNCE_MS,
        initialQuery: String = "",
    ) : this(search, debounceMs, initialQuery, Dispatchers.Default)

    private val queries = Variable(initialQuery)
    private val states = Variable(SearchState<T>(emptyList(), false))
    private val tasks = Tasks(context)

    /** The query last searched for. */
    private var searched: String? = null

    /** The search under way, abandoned when the next query settles. */
    private var following: Job? = null

    /** The query as it was last set. */
    public val query: Watched<String> = queries.reading()

    /** What the search shows. */
    public val state: Watched<SearchState<T>> = states.reading()

    init {
        tasks.run { settling() }
    }

    /** Set the query: searched for once it has stayed the same for the debounce. */
    public fun setQuery(value: String): Unit = queries.set(value)

    private suspend fun settling() {
        val changes = Channel<String>(Channel.UNLIMITED)
        tasks.run {
            query.collect { changes.send(it) }
            changes.close()
        }
        // The query it begins with, which settles like any other.
        changes.receive()
        while (true) {
            val changed = withTimeoutOrNull(debounceMs) { changes.receiveCatching() }
                ?: run {
                    settled(queries.value)
                    changes.receiveCatching()
                }
            if (changed.isClosed) return
        }
    }

    private fun settled(query: String) {
        if (query == searched) return
        searched = query
        following?.cancel()
        following = null
        val wanted = query.trim()
        if (wanted.isEmpty()) {
            states.set(SearchState(emptyList(), false))
            return
        }
        states.set(SearchState(emptyList(), true))
        following = tasks.run {
            search(wanted).collect { found -> states.set(if (found == null) SearchState(emptyList(), true) else SearchState(found, false)) }
        }
    }

    /** Stop searching: the search under way is abandoned, and the query and what it shows end. */
    override fun close() {
        tasks.stop()
        queries.end()
        states.end()
    }
}
