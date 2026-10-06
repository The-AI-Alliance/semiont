"""The rules read from the media types a knowledge base admits.

The table is `specs/src/media-types/registry.json`
(`semiont.media_types_table`), and the rules are the ones
`specs/src/media-types/cases.json` holds in every SDK: the format a clone
takes, and the name content is stored under.
"""

from typing import Final

from semiont.media_types_table import MEDIA_TYPES, MediaType
from semiont.types import Representation, ResourceDescriptor

__all__ = ["base_media_type", "capabilities_of", "clone_format", "primary_media_type", "storage_file_name", "storage_uri"]

_BY_MEDIA_TYPE: Final = {row.media_type: row for row in MEDIA_TYPES}
_PLAIN_TEXT: Final = _BY_MEDIA_TYPE["text/plain"]


def base_media_type(format: str) -> str:
    """A format without its parameters (`; charset=…`), in lower case."""
    return format.split(";", 1)[0].strip().lower()


def capabilities_of(format: str) -> MediaType | None:
    """The table's row for `format`, whose parameters are not read.

    A stored type may be one the table does not have: what was imported keeps
    the type it came with.
    """
    return _BY_MEDIA_TYPE.get(base_media_type(format))


def primary_media_type(resource: ResourceDescriptor) -> str | None:
    """The media type of a resource's first representation."""
    stated = resource.representations
    if isinstance(stated, Representation):
        return stated.media_type
    return stated[0].media_type if stated else None


def clone_format(source: str | None) -> MediaType:
    """The format a clone of a resource takes: its source's, when that is one a person can author, and plain text otherwise.

    A clone opens where a person writes.
    """
    row = None if source is None else capabilities_of(source)
    return row if row is not None and row.authorable else _PLAIN_TEXT


def storage_file_name(name: str, format: MediaType) -> str:
    """The name a resource's content is stored under.

    Its title in lower case, every run of characters that are not a to z or 0
    to 9 made one hyphen, none at either end, and then the format's
    extension.
    """
    kept: list[str] = []
    for character in name.lower():
        if character.isascii() and (character.islower() or character.isdigit()):
            kept.append(character)
        elif not kept or kept[-1] != "-":
            kept.append("-")
    return "".join(kept).strip("-") + format.extension


def storage_uri(name: str, format: MediaType) -> str:
    """The `file://` URI of `storage_file_name`: where the content is stored, at the root of the working tree."""
    return f"file://{storage_file_name(name, format)}"
