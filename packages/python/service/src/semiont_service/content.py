"""A resource's bytes, as a service reads them: what it asks, and what it is answered.

A service reads the bytes of a resource's stored representation as they are
stored, with the content type they are stored under
(`specs/src/archivist/openapi.json`). A checksum the record states is of
exactly those bytes, so whatever reads them changes none.

What reads them is behind this protocol. A service is handed a reader, and
what it does with the bytes knows no address.
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

    It says nothing of the bytes. What follows for a resource that could not
    be read is the service's to say, in its protocol's page.
    """


class ContentReads(Protocol):
    """What reads a resource's bytes. Every reader has this member and no other."""

    async def read(self, resource_id: ResourceId) -> Content:
        """The bytes of a resource's stored representation, as they are stored. Raises `ContentUnread` where they cannot be read."""
        ...
