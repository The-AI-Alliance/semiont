"""A resource's bytes, as a Smelter reads them: what it asks, and what it is answered.

A Smelter reads the bytes of a resource's stored representation as they are
stored, with the content type they are stored under
(`docs/protocol/SMELTER.md` § What it follows). The checksum it works by is
of exactly those bytes, so whatever reads them changes none.

What reads them is behind this protocol. The Smelter is handed a reader, and
knows no address.
"""

from dataclasses import dataclass
from typing import Protocol, final

from semiont.identifiers import ResourceId

__all__ = ["Content", "ContentReads", "ContentUnread"]


@final
@dataclass(frozen=True, slots=True)
class Content:
    """A resource's bytes, and the content type they came with: the media type, and whatever parameters it states."""

    data: bytes
    content_type: str


@final
class ContentUnread(Exception):
    """A resource's bytes could not be read: nothing answered, or what answered gave none.

    It says nothing of the bytes. A Smelter decides nothing of a resource it
    could not read (`docs/protocol/SMELTER.md` § What it decides).
    """


class ContentReads(Protocol):
    """What reads a resource's bytes. Every reader has this member and no other."""

    async def read(self, resource_id: ResourceId) -> Content:
        """The bytes of a resource's stored representation, as they are stored. Raises `ContentUnread` where they cannot be read."""
        ...
