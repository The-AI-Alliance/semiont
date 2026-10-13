"""What a Smelter reads of the record: the catalog of what is not archived, a resource's entity types, and a resource's annotations.

It reads them from the Archivist, over the bus (`docs/protocol/SMELTER.md` §
What it follows), and opens no file of the record. A resource's bytes are
another read, and no part of this (`semiont_service.content`).
"""

import asyncio
from typing import Final, final

from semiont.bus import Bus
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_ANNOTATIONS_REQUESTED, BROWSE_RESOURCE_REQUESTED, BROWSE_RESOURCES_REQUESTED
from semiont.resources import resource_entity_types
from semiont.types import Annotation, BrowseAnnotationsRequest, BrowseResourceRequest, ResourceDescriptor
from semiont_service import catalog

__all__ = ["READ", "Record"]

READ: Final = (BROWSE_RESOURCES_REQUESTED, BROWSE_RESOURCE_REQUESTED, BROWSE_ANNOTATIONS_REQUESTED)
"""The operations a Smelter awaits: its stream names their replies."""


@final
class Record:
    """The record, as a Smelter reads it over `bus`. Once `stopping` is set, a page of the catalog nobody answers is not asked for again."""

    def __init__(self, bus: Bus, stopping: asyncio.Event) -> None:
        self._bus: Final = bus
        self._stopping: Final = stopping

    async def resources(self) -> list[ResourceDescriptor]:
        """Every resource of the catalog that is not archived (`semiont_service.catalog`)."""
        return await catalog.resources(self._bus, self._stopping, archived=False)

    async def described(self, resource_id: ResourceId) -> ResourceDescriptor:
        """A resource's description, as the Archivist answers it now. A read that fails is raised."""
        return (await self._bus.request(BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resource_id=resource_id))).response.resource

    async def entity_types(self, resource_id: ResourceId) -> list[str]:
        """A resource's entity types, as its description states them now.

        A read that fails is raised: points written with no entity types
        would be found by a search that was to leave the resource out.
        """
        return resource_entity_types(await self.described(resource_id))

    async def archived(self, resource_id: ResourceId) -> bool:
        """Whether a resource is archived, as its description states it now: one that is, is no resource of the catalog."""
        return (await self.described(resource_id)).archived is True

    async def annotations(self, resource_id: ResourceId) -> list[Annotation]:
        """A resource's annotations, as the record's view holds them."""
        return (
            await self._bus.request(BROWSE_ANNOTATIONS_REQUESTED, BrowseAnnotationsRequest(resource_id=resource_id))
        ).response.annotations
