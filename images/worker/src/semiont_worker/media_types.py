"""What the worker reads of a media type for itself: whether a `yield` job can write it.

It is a column of `specs/src/media-types/registry.json`, the media types a
knowledge base admits, and is read from the SDK's table of it
(`semiont.media_types_table`). Where a type's text comes from is the SDK's to
say (`semiont.media_types.text_source_of`).
"""

from typing import Final

from semiont.media_types_table import MEDIA_TYPES

GENERATABLE_MEDIA_TYPES: Final[tuple[str, ...]] = tuple(row.media_type for row in MEDIA_TYPES if row.generatable)
"""The media types the registry marks `generatable`, in its order: what a `yield` job can write."""
