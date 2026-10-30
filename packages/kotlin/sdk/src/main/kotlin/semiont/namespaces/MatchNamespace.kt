package semiont.namespaces

import semiont.bus.Operations
import semiont.types.MatchSearchRequest

/** Searching: for what a reference could refer to, and for resources by text. */
public class MatchNamespace internal constructor(private val links: Links) {
    /** Signal: a search is wanted. The client's own state runs it, and answers under `correlationId`. */
    public fun requestSearch(request: MatchSearchRequest, correlationId: String): Unit =
        links.signal(Operations.MATCH_SEARCH_REQUESTED.request, request, correlationId)
}
