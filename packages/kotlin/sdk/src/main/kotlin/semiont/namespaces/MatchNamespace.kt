@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import kotlinx.serialization.json.JsonPrimitive
import semiont.Running
import semiont.bus.Operations
import semiont.errors.BusRequestError
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.types.GatheredContext
import semiont.types.MatchSearchRequest
import semiont.types.MatchSearchResult

/** Searching: for what a reference could refer to, and for resources by text. */
public class MatchNamespace internal constructor(private val links: Links) {
    /** Candidates for a reference, given its gathered context: ten, scored semantically, when nothing else is stated. */
    @JvmOverloads
    @JvmExposeBoxed
    public fun search(
        resourceId: ResourceId,
        referenceId: AnnotationId,
        context: GatheredContext,
        limit: Long = 10,
        useSemanticScoring: Boolean = true,
    ): Running<MatchSearchResult> {
        val request = MatchSearchRequest(resourceId = resourceId, referenceId = referenceId, context = context, limit = limit, useSemanticScoring = useSemanticScoring)
        return Running(links.scope) { searched(request) }
    }

    private suspend fun searched(request: MatchSearchRequest): MatchSearchResult = try {
        links.request(Operations.MATCH_SEARCH_REQUESTED, request)
    } catch (failure: BusRequestError) {
        // A search's failure says what went wrong under `error`, where every other operation's says it under `message`.
        val said = (failure.failure?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw failure
        throw BusRequestError(failure.reason, said, failure.failure)
    }

    /** Signal: a search is wanted. The client's own state runs it, and answers under `correlationId`. */
    public fun requestSearch(request: MatchSearchRequest, correlationId: String): Unit =
        links.signal(Operations.MATCH_SEARCH_REQUESTED.request, request, correlationId)
}
