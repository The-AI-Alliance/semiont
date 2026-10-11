"""What a Weaver reads of the record: the catalog, a resource's events, and a resource's annotations.

It reads them from the Archivist, over the bus (`docs/protocol/WEAVER.md` §
What it follows), and opens no file of the record.
"""

import asyncio
from typing import Final, final

from semiont.bus import Bus
from semiont.errors import BusRequestError, SemiontError
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_ANNOTATIONS_REQUESTED, BROWSE_EVENTS_REQUESTED, BROWSE_RESOURCES_REQUESTED
from semiont.retry import RetryPolicy, retry_with_backoff
from semiont.types import (
    Annotation,
    BrowseAnnotationsRequest,
    BrowseEventsRequest,
    BrowseResourcesRequest,
    BrowseResourcesResult,
    ResourceDescriptor,
    StoredEventResponse,
)

__all__ = ["READ", "History"]

READ: Final = (BROWSE_RESOURCES_REQUESTED, BROWSE_EVENTS_REQUESTED, BROWSE_ANNOTATIONS_REQUESTED)
"""The operations a Weaver awaits: its stream names their replies."""

_PAGE: Final = 200
"""How many resources of the catalog are asked for at once."""

_UNTIL_THE_ARCHIVIST_ANSWERS: Final = RetryPolicy(attempts=17, initial_delay_ms=1_000, max_delay_ms=30_000)
"""How long a page of the catalog is asked for while the Archivist is not there to answer.

A Weaver that signs in before the Archivist has subscribed asks a channel
nobody answers yet. The Archivist's own start can take minutes, and this is
sized by that: about five and a half minutes in all.
"""


def _nobody_answers(failure: SemiontError) -> bool:
    return isinstance(failure, BusRequestError) and failure.code == "bus.peer-unavailable"


@final
class History:
    """The record, as a Weaver reads it over `bus`. Once `stopping` is set, a read that nobody answers is not asked again."""

    def __init__(self, bus: Bus, stopping: asyncio.Event) -> None:
        self._bus: Final = bus
        self._stopping: Final = stopping

    async def resources(self) -> list[ResourceDescriptor]:
        """Every resource of the catalog, the archived among them.

        Asked for a page at a time, and each page again while the Archivist
        is not there: asking for the whole catalog again would ask again for
        every page already answered.
        """
        every: list[ResourceDescriptor] = []
        while True:
            asked = BrowseResourcesRequest(offset=len(every), limit=_PAGE)

            async def page(asked: BrowseResourcesRequest = asked) -> BrowseResourcesResult:
                return await self._bus.request(BROWSE_RESOURCES_REQUESTED, asked)

            answered = (
                await retry_with_backoff(_UNTIL_THE_ARCHIVIST_ANSWERS, page, retryable=_nobody_answers, give_up=self._stopping)
            ).response
            every.extend(answered.resources)
            if not answered.resources or len(every) >= answered.total:
                return every

    async def events(self, resource_id: ResourceId) -> list[StoredEventResponse]:
        """A resource's events, every one the record holds, in the order of their sequence numbers."""
        answered = (await self._bus.request(BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resource_id=resource_id))).response
        return sorted(answered.events, key=lambda event: event.metadata.sequence_number)

    async def annotations(self, resource_id: ResourceId) -> list[Annotation]:
        """A resource's annotations, as the record's view holds them."""
        return (
            await self._bus.request(BROWSE_ANNOTATIONS_REQUESTED, BrowseAnnotationsRequest(resource_id=resource_id))
        ).response.annotations
