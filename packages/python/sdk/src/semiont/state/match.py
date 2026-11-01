"""Matching, run for whoever asks on the client's own bus.

A search is asked for by a signal (`client.match.request_search`), which carries
a correlation id. This unit runs it, and answers on the same bus under the same
id: `match:search-results`, or `match:search-failed` with the reference it was
for and what went wrong. It holds no state of its own: what it found is what it
said.
"""

from types import TracebackType
from typing import Final, Self, TypedDict, final, override

from semiont.bus import Delivered, FrameRefusal, Typed
from semiont.channels import MATCH_SEARCH_FAILED, MATCH_SEARCH_REQUESTED, MATCH_SEARCH_RESULTS
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.state._tasks import Tasks
from semiont.state_unit import StateUnit
from semiont.transport import Transport
from semiont.types import MatchSearchFailed, MatchSearchRequest

__all__ = ["MatchStateUnit"]


class _Options(TypedDict, total=False):
    """What a request states of the search's options. One it leaves out is the namespace's to choose."""

    limit: int
    use_semantic_scoring: bool


def _options(request: MatchSearchRequest) -> _Options:
    options: _Options = {}
    if request.limit is not None:
        options["limit"] = request.limit
    if request.use_semantic_scoring is not None:
        options["use_semantic_scoring"] = request.use_semantic_scoring
    return options


@final
class MatchStateUnit(StateUnit):
    """See the module's documentation."""

    def __init__(self, client: SemiontClient[Transport]) -> None:
        self._client: Final = client
        self._tasks: Final = Tasks()
        # Taken now, so that a search asked for from here on is heard.
        self._tasks.run(self._listen(client.bus.frames(MATCH_SEARCH_REQUESTED)))

    async def _listen(self, heard: Typed[MatchSearchRequest]) -> None:
        async with heard:
            async for asked in heard:
                match asked:
                    case Delivered():
                        self._tasks.run(self._search(asked.payload, asked.correlation_id))
                    case FrameRefusal():
                        # A request that is not a search's names nothing to search for.
                        pass

    async def _search(self, request: MatchSearchRequest, correlation_id: str | None) -> None:
        try:
            found = await self._client.match.search(request.resource_id, request.reference_id, request.context, **_options(request))
        except SemiontError as error:
            failed = MatchSearchFailed(reference_id=request.reference_id, error=error.message)
            self._client.bus.publish(MATCH_SEARCH_FAILED, failed, correlation_id=correlation_id)
            return
        self._client.bus.publish(MATCH_SEARCH_RESULTS, found, correlation_id=correlation_id)

    @override
    def dispose(self) -> None:
        self._tasks.stop()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.dispose()
        await self._tasks.ended()
