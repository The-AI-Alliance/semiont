"""Frame: the knowledge base's vocabulary.

Each write is confirmed: it resolves when the knowledge base says it is
recorded, and fails with the failure it answered.
"""

from collections.abc import Sequence
from typing import Final, final

from semiont.namespaces.links import Links
from semiont.operations import FRAME_ADD_ENTITY_TYPE, FRAME_ADD_TAG_SCHEMA
from semiont.types import FrameAddEntityTypeCommand, FrameAddTagSchemaCommand, TagSchema

__all__ = ["FrameNamespace"]


@final
class FrameNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links) -> None:
        self._links: Final = links

    async def add_entity_type(self, entity_type: str) -> None:
        """Add one entity type. Adding one that is there already changes nothing."""
        await self._links.request(FRAME_ADD_ENTITY_TYPE, FrameAddEntityTypeCommand(tag=entity_type))

    async def add_entity_types(self, entity_types: Sequence[str]) -> None:
        """Add several, one request each, in order. The first that fails ends it."""
        for entity_type in entity_types:
            await self.add_entity_type(entity_type)

    async def add_tag_schema(self, schema: TagSchema) -> None:
        """Register a tag schema. The last registration under an id is the one that stands."""
        await self._links.request(FRAME_ADD_TAG_SCHEMA, FrameAddTagSchemaCommand(schema_=schema))
