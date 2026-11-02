# Generated from specs/src/media-types/registry.json; do not edit.
# Regenerate: node packages/codegen/schemas/generate-media-types-python.mjs

"""The media types a knowledge base admits, with what this SDK reads of each."""

from dataclasses import dataclass
from typing import Final, Literal, final

__all__ = ["MEDIA_TYPES", "MediaType", "TextSource"]

type TextSource = Literal["decode", "pdf-text-layer", "none"]
"""Where a type's text comes from: decoded from its own bytes, derived by reading them, or nowhere."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class MediaType:
    """One media type a knowledge base admits."""

    media_type: str
    extension: str
    """The extension a stored name takes, with its dot."""
    text_source: TextSource
    authorable: bool
    """Offered where a person writes a resource."""
    generatable: bool
    """The generation worker can produce it."""


# The registry, in its own order: 63 media types.
MEDIA_TYPES: Final[tuple[MediaType, ...]] = (
    MediaType(media_type="text/markdown", extension=".md", text_source="decode", authorable=True, generatable=True),
    MediaType(media_type="text/plain", extension=".txt", text_source="decode", authorable=True, generatable=True),
    MediaType(media_type="text/html", extension=".html", text_source="decode", authorable=True, generatable=False),
    MediaType(media_type="application/json", extension=".json", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="image/png", extension=".png", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="image/jpeg", extension=".jpg", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/pdf", extension=".pdf", text_source="pdf-text-layer", authorable=False, generatable=True),
    MediaType(media_type="text/css", extension=".css", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/csv", extension=".csv", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/xml", extension=".xml", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="application/xml", extension=".xml", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="application/yaml", extension=".yaml", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="application/x-yaml", extension=".yaml", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/javascript", extension=".js", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="application/javascript", extension=".js", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-typescript", extension=".ts", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="application/typescript", extension=".ts", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-python", extension=".py", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-java", extension=".java", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-c", extension=".c", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-c++", extension=".cpp", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-csharp", extension=".cs", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-go", extension=".go", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-rust", extension=".rs", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-ruby", extension=".rb", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-php", extension=".php", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-swift", extension=".swift", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-kotlin", extension=".kt", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="text/x-shell", extension=".sh", text_source="decode", authorable=False, generatable=False),
    MediaType(media_type="application/msword", extension=".doc", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension=".docx", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/vnd.ms-excel", extension=".xls", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension=".xlsx", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/vnd.ms-powerpoint", extension=".ppt", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation", extension=".pptx", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/zip", extension=".zip", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/gzip", extension=".gz", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/x-tar", extension=".tar", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/x-7z-compressed", extension=".7z", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/octet-stream", extension=".bin", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="application/wasm", extension=".wasm", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="image/gif", extension=".gif", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="image/webp", extension=".webp", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="image/svg+xml", extension=".svg", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="image/bmp", extension=".bmp", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="image/tiff", extension=".tiff", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="image/x-icon", extension=".ico", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="video/mp4", extension=".mp4", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="video/mpeg", extension=".mpeg", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="video/webm", extension=".webm", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="video/ogg", extension=".ogv", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="video/quicktime", extension=".mov", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="video/x-msvideo", extension=".avi", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="audio/mpeg", extension=".mp3", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="audio/wav", extension=".wav", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="audio/ogg", extension=".ogg", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="audio/webm", extension=".webm", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="audio/aac", extension=".aac", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="audio/flac", extension=".flac", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="font/woff", extension=".woff", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="font/woff2", extension=".woff2", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="font/ttf", extension=".ttf", text_source="none", authorable=False, generatable=False),
    MediaType(media_type="font/otf", extension=".otf", text_source="none", authorable=False, generatable=False),
)
