"""What a Weaver reads of the record: the catalog, a resource's events, and a resource's annotations.

It reads the catalog and a resource's events from the Archivist, over the
bus, and a resource's annotations through the gateway, by the content
transport's `GET /resources/{id}/annotations`: their number follows the
document's, so they are no bus read (`docs/protocol/WEAVER.md` § What it
follows). It opens no file of the record.
"""

import asyncio
from typing import Final, final

from semiont.bus import Bus
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_EVENTS_REQUESTED, BROWSE_RESOURCES_REQUESTED
from semiont.transport import ContentTransport
from semiont.types import Annotation, BrowseEventsRequest, ResourceDescriptor, StoredEventResponse
from semiont_service import catalog

__all__ = ["READ", "History"]

READ: Final = (BROWSE_RESOURCES_REQUESTED, BROWSE_EVENTS_REQUESTED)
"""The operations a Weaver awaits: its stream names their replies."""


@final
class History:
    """The record, as a Weaver reads it over `bus` and through `content`.

    Once `stopping` is set, a read that nobody answers is not asked again.
    """

    def __init__(self, bus: Bus, content: ContentTransport, stopping: asyncio.Event) -> None:
        self._bus: Final = bus
        self._content: Final = content
        self._stopping: Final = stopping

    async def resources(self) -> list[ResourceDescriptor]:
        """Every resource of the catalog, the archived among them (`semiont_service.catalog`)."""
        return await catalog.resources(self._bus, self._stopping, archived=None)

    async def events(self, resource_id: ResourceId) -> list[StoredEventResponse]:
        """A resource's events, every one the record holds, in the order of their sequence numbers."""
        answered = (await self._bus.request(BROWSE_EVENTS_REQUESTED, BrowseEventsRequest(resource_id=resource_id))).response
        return sorted(answered.events, key=lambda event: event.metadata.sequence_number)

    async def annotations(self, resource_id: ResourceId) -> list[Annotation]:
        """A resource's annotations, as the record's view holds them."""
        return (await self._content.get_annotations(resource_id)).annotations
