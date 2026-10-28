"""What a Weaver reads of the record beside following it: the catalog, and a resource's annotations.

It reads the catalog from the Archivist, over the bus, and a resource's
annotations from the Archivist's own `GET /resources/{id}/annotations`, as its
service account: their number follows the document's, so they are no bus read
(`docs/protocol/WEAVER.md` § What it follows). A resource's events it reads as
a follower of the record (`semiont_service.follower`). It opens no file of the
record.
"""

import asyncio
from typing import Final, final

from semiont.bus import Bus
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_RESOURCES_REQUESTED
from semiont.types import Annotation, ResourceDescriptor
from semiont_service import catalog
from semiont_service.archivist import AnnotationReads

__all__ = ["READ", "History"]

READ: Final = (BROWSE_RESOURCES_REQUESTED,)
"""The operations a Weaver awaits: its stream names their replies."""


@final
class History:
    """The catalog, as a Weaver reads it over `bus`, and a resource's annotations, as `annotations` reads them.

    Once `stopping` is set, a page of the catalog nobody answers is not asked for again.
    """

    def __init__(self, bus: Bus, annotations: AnnotationReads, stopping: asyncio.Event) -> None:
        self._bus: Final = bus
        self._annotations: Final = annotations
        self._stopping: Final = stopping

    async def resources(self) -> list[ResourceDescriptor]:
        """Every resource of the catalog, the archived among them (`semiont_service.catalog`)."""
        return await catalog.resources(self._bus, self._stopping, archived=None)

    async def annotations(self, resource_id: ResourceId) -> list[Annotation]:
        """A resource's annotations, as the record's view holds them. A read that fails is raised."""
        return (await self._annotations.read_annotations(resource_id)).annotations
