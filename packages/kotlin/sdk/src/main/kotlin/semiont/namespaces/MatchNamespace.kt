@file:OptIn(kotlin.ExperimentalStdlibApi::class)

package semiont.namespaces

import kotlinx.serialization.json.JsonPrimitive
import semiont.Running
import semiont.bus.Operations
import semiont.cache.Cached
import semiont.cache.Keyed
import semiont.errors.BusRequestError
import semiont.identifiers.AnnotationId
import semiont.identifiers.ResourceId
import semiont.types.GatheredContext
import semiont.types.MatchResourcesResponse
import semiont.types.MatchSearchRequest
import semiont.types.MatchSearchResult

/** Searching: for what a reference could refer to, and for resources by text. */
public class MatchNamespace internal constructor(private val links: Links, private val live: Live) {
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

    /**
     * The resources a text search finds, among those the filters admit: the
     * first hundred when nothing is stated, `offset` of them passed over
     * before the page begins. A live query, kept true by the same events as
     * `browse.resources` and no others.
     */
    @JvmOverloads
    public fun resources(
        search: String,
        limit: Long = LIST_LIMIT,
        offset: Long = 0,
        archived: Boolean? = null,
        entityType: String? = null,
    ): Cached<MatchResourcesResponse> = live.query(Keyed(live.searches, ResourceSearch(search, ResourceFilters(limit, offset, archived, entityType)), { it }))
}
