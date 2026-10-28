"""The catalog of a knowledge base's resources, read whole from the Archivist, over the bus.

A service that follows the record reads the catalog when it starts, to find
what it missed. It asks for it a page at a time, and asks for a page again
while the Archivist is not there to answer: a service that signs in before
the Archivist has subscribed asks a channel nobody answers yet.
"""

import asyncio
from typing import Final

from semiont.bus import Bus
from semiont.errors import BusRequestError, SemiontError
from semiont.operations import BROWSE_RESOURCES_REQUESTED
from semiont.retry import RetryPolicy, retry_with_backoff
from semiont.types import BrowseResourcesRequest, BrowseResourcesResult, ResourceDescriptor

__all__ = ["resources"]

_PAGE: Final = 200
"""How many resources of the catalog are asked for at once."""

_UNTIL_THE_ARCHIVIST_ANSWERS: Final = RetryPolicy(attempts=17, initial_delay_ms=1_000, max_delay_ms=30_000)
"""How long a page of the catalog is asked for while the Archivist is not there to answer.

The Archivist's own start can take minutes, and this is sized by that: about
five and a half minutes in all.
"""


def _nobody_answers(failure: SemiontError) -> bool:
    return isinstance(failure, BusRequestError) and failure.code == "bus.peer-unavailable"


async def resources(bus: Bus, stopping: asyncio.Event, *, archived: bool | None) -> list[ResourceDescriptor]:
    """Every resource of the catalog, in the order the Archivist lists them.

    `archived` says which are asked for: `False` those that are not archived,
    `True` those that are, and `None` every one, with nothing said of it in
    the request.

    Each page is asked for again while the Archivist is not there: asking for
    the whole catalog again would ask again for every page already answered.
    Once `stopping` is set, a page nobody answers is not asked for again. Any
    other failure of a page is raised as it was.
    """
    every: list[ResourceDescriptor] = []
    while True:
        asked = BrowseResourcesRequest(archived=archived, offset=len(every), limit=_PAGE)

        async def page(asked: BrowseResourcesRequest = asked) -> BrowseResourcesResult:
            return await bus.request(BROWSE_RESOURCES_REQUESTED, asked)

        answered = (await retry_with_backoff(_UNTIL_THE_ARCHIVIST_ANSWERS, page, retryable=_nobody_answers, give_up=stopping)).response
        every.extend(answered.resources)
        if not answered.resources or len(every) >= answered.total:
            return every
