"""Match: searching, for what a reference could refer to and for resources by text."""

from typing import Final, final

from semiont.cached import Cached
from semiont.errors import BusRequestError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.operations import MATCH_RESOURCES_REQUESTED, MATCH_SEARCH_REQUESTED
from semiont.running import Running
from semiont.types import GatheredContext, MatchResourcesRequest, MatchResourcesResponse, MatchSearchRequest, MatchSearchResult

__all__ = ["MatchNamespace"]

# What a caller that states nothing is given. Every SDK asks for as many: the
# cases of specs/src/client/surface.json hold each to it.
_CANDIDATES: Final = 10
_LIST_LIMIT: Final = 100


@final
class MatchNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links) -> None:
        self._links: Final = links

    def search(
        self,
        resource_id: ResourceId,
        reference_id: AnnotationId,
        context: GatheredContext,
        *,
        limit: int = _CANDIDATES,
        use_semantic_scoring: bool = True,
    ) -> Running[MatchSearchResult]:
        """Candidates for a reference, given its gathered context: ten, scored semantically, when nothing else is stated."""
        request = MatchSearchRequest(
            resource_id=resource_id, reference_id=reference_id, context=context, limit=limit, use_semantic_scoring=use_semantic_scoring
        )
        return Running(lambda _: self._links.run(self._searched(request)))

    async def _searched(self, request: MatchSearchRequest) -> MatchSearchResult:
        try:
            return await self._links.request(MATCH_SEARCH_REQUESTED, request)
        except BusRequestError as failure:
            # A search's failure says what went wrong under `error`, where every other operation's says it under `message`.
            said = None if failure.failure is None else failure.failure.get("error")
            if isinstance(said, str):
                raise BusRequestError(failure.code, said, failure=failure.failure) from failure
            raise

    def request_search(self, request: MatchSearchRequest, correlation_id: str) -> None:
        """Signal: a search is wanted. The client's own state runs it, and answers under `correlation_id`."""
        self._links.signal(MATCH_SEARCH_REQUESTED.request, request, correlation_id=correlation_id)

    def resources(
        self, search: str, *, limit: int = _LIST_LIMIT, archived: bool | None = None, entity_type: str | None = None
    ) -> Cached[MatchResourcesResponse]:
        """A page of the resources a search for `search` finds, among those the filters admit: the first hundred when no limit is stated.

        The text is matched lexically and, when nothing matches, by meaning:
        the answer's `match_kind` says which it is.
        """
        request = MatchResourcesRequest(search=search, limit=limit, offset=0, archived=archived, entity_type=entity_type)
        return Cached(lambda: self._found(request))

    async def _found(self, request: MatchResourcesRequest) -> MatchResourcesResponse:
        return (await self._links.request(MATCH_RESOURCES_REQUESTED, request)).response
