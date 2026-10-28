"""Bind: linking a reference to what it refers to."""

from collections.abc import Sequence
from typing import Final, final

from semiont.channels import BIND_BODY_ERROR, BIND_INITIATE
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.operations import BIND_UPDATE_BODY
from semiont.types import BindBodyOperation, BindInitiateCommand, BindUpdateBodyCommand, ResourceErrorEvent

__all__ = ["BindNamespace"]


@final
class BindNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links) -> None:
        self._links: Final = links

    async def body(self, resource_id: ResourceId, annotation_id: AnnotationId, operations: Sequence[BindBodyOperation]) -> None:
        """Change an annotation's body.

        Confirmed: it resolves when the change is recorded, and fails with the
        failure the knowledge base answered.
        """
        await self._links.request(
            BIND_UPDATE_BODY, BindUpdateBodyCommand(annotation_id=annotation_id, resource_id=resource_id, operations=list(operations))
        )

    def initiate(self, command: BindInitiateCommand) -> None:
        """Signal: a binding is wanted for an annotation."""
        self._links.signal(BIND_INITIATE, command)

    def report_body_error(self, event: ResourceErrorEvent) -> None:
        """Signal: a body update failed where nothing could show it."""
        self._links.signal(BIND_BODY_ERROR, event)
