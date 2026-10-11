"""What the worker reads of a media type: where its text comes from, and whether a `yield` job can write it.

Both are columns of `specs/src/media-types/registry.json`, the media types a
knowledge base admits, and are read from the SDK's table of it
(`semiont.media_types_table`). What is the worker's own is where the text of
a type the registry lacks comes from.
"""

from typing import Final

from semiont.media_types import base_media_type, capabilities_of
from semiont.media_types_table import MEDIA_TYPES, TextSource

GENERATABLE_MEDIA_TYPES: Final[tuple[str, ...]] = tuple(row.media_type for row in MEDIA_TYPES if row.generatable)
"""The media types the registry marks `generatable`, in its order: what a `yield` job can write."""


def text_source_of(media_type: str) -> TextSource:
    """Where the text of a resource of `media_type` comes from. The type's parameters and its case are not read.

    `decode`: its bytes are its text, in some charset. `pdf-text-layer`: its
    text is read out of it by the Smelter, which also says where each run of
    the text is on a page. `none`: it has no text.

    A type the registry has answers as its row says. One it lacks is decoded
    when it is a `text/` type, which is text by what the type says of itself,
    and has no text otherwise.
    """
    row = capabilities_of(media_type)
    if row is None:
        return "decode" if base_media_type(media_type).startswith("text/") else "none"
    return row.text_source
