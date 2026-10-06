"""Beckon: attention.

The drives go over the wire, to every other participant, and resolve with how
many the gateway reached, or with no count when it kept none. The signals are
this viewer's own and never leave the client.
"""

from typing import Final, final

from semiont.channels import BECKON_FOCUS, BECKON_HOVER, BECKON_SPARKLE, BROWSE_CLICK, BROWSE_RESOURCE_OPEN
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.types import BeckonFocusEvent, BeckonHoverEvent, BeckonSparkleEvent, BrowseClickEvent, BrowseResourceOpenEvent

__all__ = ["BeckonNamespace"]


@final
class BeckonNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links) -> None:
        self._links: Final = links

    async def attention(self, resource_id: ResourceId, annotation_id: AnnotationId) -> int | None:
        """Point the other participants at an annotation."""
        return await self._links.drive(BECKON_FOCUS, BeckonFocusEvent(annotation_id=annotation_id, resource_id=resource_id))

    async def click(self, annotation_id: AnnotationId) -> int | None:
        """Open an annotation on the other participants' screens."""
        return await self._links.drive(BROWSE_CLICK, BrowseClickEvent(annotation_id=annotation_id))

    async def open_resource(self, resource_id: ResourceId) -> int | None:
        """Open a resource on the other participants' screens."""
        return await self._links.drive(BROWSE_RESOURCE_OPEN, BrowseResourceOpenEvent(resource_id=resource_id))

    async def sparkle_all(self, annotation_id: AnnotationId) -> int | None:
        """Sparkle an annotation on every participant's viewer."""
        return await self._links.drive(BECKON_SPARKLE, BeckonSparkleEvent(annotation_id=annotation_id))

    def hover(self, annotation_id: AnnotationId | None) -> None:
        """Signal: this viewer hovers an annotation, or none."""
        self._links.signal(BECKON_HOVER, BeckonHoverEvent(annotation_id=annotation_id))

    def sparkle(self, annotation_id: AnnotationId) -> None:
        """Signal: sparkle an annotation on this viewer alone."""
        self._links.signal(BECKON_SPARKLE, BeckonSparkleEvent(annotation_id=annotation_id))
