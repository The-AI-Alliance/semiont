package semiont.state

import semiont.SemiontClient
import semiont.StateUnit
import semiont.channels.Channels
import semiont.errors.SemiontError
import semiont.namespaces.SEARCH_LIMIT
import semiont.namespaces.SEMANTIC_SCORING
import semiont.types.MatchSearchFailed
import semiont.types.MatchSearchRequest

/**
 * Matching, run for whoever asks on the client's own bus. A search is asked
 * for by a signal (`client.match.requestSearch`), which carries a correlation
 * id; this unit runs it, and answers on the same bus under the same id:
 * `match:search-results`, or `match:search-failed` with the reference it was
 * for and what went wrong. It holds no state: what it found is what it said.
 * Its work runs in the client's, and it never closes the client.
 */
public class MatchStateUnit(private val client: SemiontClient) : StateUnit {
    private val tasks = Tasks(client.links.scope.coroutineContext)

    init {
        // Taken now, so that a search asked for from here on is heard.
        val asked = client.bus.frames(Channels.MATCH_SEARCH_REQUESTED, null)
        tasks.run { asked.collect { tasks.run { search(it.payload, it.correlationId) } } }
    }

    private suspend fun search(request: MatchSearchRequest, correlationId: String?) {
        val running = client.match.search(
            request.resourceId,
            request.referenceId,
            request.context,
            request.limit ?: SEARCH_LIMIT,
            request.useSemanticScoring ?: SEMANTIC_SCORING,
        )
        val found = try {
            running.await()
        } catch (failure: SemiontError) {
            client.bus.publish(Channels.MATCH_SEARCH_FAILED, MatchSearchFailed(referenceId = request.referenceId, error = failure.message ?: ""), null, correlationId)
            return
        }
        client.bus.publish(Channels.MATCH_SEARCH_RESULTS, found, null, correlationId)
    }

    /** Stop running searches: one under way is abandoned, and none asked for after is run. */
    override fun close(): Unit = tasks.stop()
}
