"""What the worker reads of a media type: where its text comes from, and whether a `yield` job can write it.

Both are columns of `specs/src/media-types/registry.json`, the media types a
knowledge base admits. The SDK's table of the registry carries neither, so
they are written out here by hand, and a test holds them to the registry,
each row and its order.
"""

from collections.abc import Mapping
from typing import Final, Literal

from semiont.media_types import base_media_type, capabilities_of
from semiont.types import SupportedMediaType

type TextSource = Literal["decode", "pdf-text-layer", "none"]
"""Where a media type's text comes from.

`decode`: its bytes are its text, in some charset. `pdf-text-layer`: its text
is read out of it by the Smelter, which also says where each run of the text
is on a page. `none`: it has no text.
"""

TEXT_SOURCES: Final[Mapping[str, TextSource]] = {
    "text/markdown": "decode",
    "text/plain": "decode",
    "text/html": "decode",
    "application/json": "decode",
    "image/png": "none",
    "image/jpeg": "none",
    "application/pdf": "pdf-text-layer",
    "text/css": "decode",
    "text/csv": "decode",
    "text/xml": "decode",
    "application/xml": "decode",
    "application/yaml": "decode",
    "application/x-yaml": "decode",
    "text/javascript": "decode",
    "application/javascript": "decode",
    "text/x-typescript": "decode",
    "application/typescript": "decode",
    "text/x-python": "decode",
    "text/x-java": "decode",
    "text/x-c": "decode",
    "text/x-c++": "decode",
    "text/x-csharp": "decode",
    "text/x-go": "decode",
    "text/x-rust": "decode",
    "text/x-ruby": "decode",
    "text/x-php": "decode",
    "text/x-swift": "decode",
    "text/x-kotlin": "decode",
    "text/x-shell": "decode",
    "application/msword": "none",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "none",
    "application/vnd.ms-excel": "none",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "none",
    "application/vnd.ms-powerpoint": "none",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "none",
    "application/zip": "none",
    "application/gzip": "none",
    "application/x-tar": "none",
    "application/x-7z-compressed": "none",
    "application/octet-stream": "none",
    "application/wasm": "none",
    "image/gif": "none",
    "image/webp": "none",
    "image/svg+xml": "none",
    "image/bmp": "none",
    "image/tiff": "none",
    "image/x-icon": "none",
    "video/mp4": "none",
    "video/mpeg": "none",
    "video/webm": "none",
    "video/ogg": "none",
    "video/quicktime": "none",
    "video/x-msvideo": "none",
    "audio/mpeg": "none",
    "audio/wav": "none",
    "audio/ogg": "none",
    "audio/webm": "none",
    "audio/aac": "none",
    "audio/flac": "none",
    "font/woff": "none",
    "font/woff2": "none",
    "font/ttf": "none",
    "font/otf": "none",
}
"""Where the text of each media type of the registry comes from, in the registry's order."""

GENERATABLE_MEDIA_TYPES: Final[tuple[SupportedMediaType, ...]] = ("text/markdown", "text/plain", "application/pdf")
"""The media types the registry marks `generatable`, in its order: what a `yield` job can write."""


def text_source_of(media_type: str) -> TextSource:
    """Where the text of a resource of `media_type` comes from. The type's parameters and its case are not read.

    A type the registry has answers as its row says. One it lacks is decoded
    when it is a `text/` type, which is text by what the type says of itself,
    and has no text otherwise.
    """
    row = capabilities_of(media_type)
    if row is None:
        return "decode" if base_media_type(media_type).startswith("text/") else "none"
    return TEXT_SOURCES[row.media_type]
