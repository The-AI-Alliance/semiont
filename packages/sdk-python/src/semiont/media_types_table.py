# Generated from specs/src/media-types/registry.json; do not edit.
# Regenerate: node scripts/spec/generate-media-types-python.mjs

"""The media types a knowledge base admits, with what this SDK reads of each."""

from dataclasses import dataclass
from typing import Final, final

__all__ = ["MEDIA_TYPES", "MediaType"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class MediaType:
    """One media type a knowledge base admits."""

    media_type: str
    extension: str
    """The extension a stored name takes, with its dot."""
    authorable: bool
    """Offered where a person writes a resource."""


# The registry, in its own order: 63 media types.
MEDIA_TYPES: Final[tuple[MediaType, ...]] = (
    MediaType(media_type="text/markdown", extension=".md", authorable=True),
    MediaType(media_type="text/plain", extension=".txt", authorable=True),
    MediaType(media_type="text/html", extension=".html", authorable=True),
    MediaType(media_type="application/json", extension=".json", authorable=False),
    MediaType(media_type="image/png", extension=".png", authorable=False),
    MediaType(media_type="image/jpeg", extension=".jpg", authorable=False),
    MediaType(media_type="application/pdf", extension=".pdf", authorable=False),
    MediaType(media_type="text/css", extension=".css", authorable=False),
    MediaType(media_type="text/csv", extension=".csv", authorable=False),
    MediaType(media_type="text/xml", extension=".xml", authorable=False),
    MediaType(media_type="application/xml", extension=".xml", authorable=False),
    MediaType(media_type="application/yaml", extension=".yaml", authorable=False),
    MediaType(media_type="application/x-yaml", extension=".yaml", authorable=False),
    MediaType(media_type="text/javascript", extension=".js", authorable=False),
    MediaType(media_type="application/javascript", extension=".js", authorable=False),
    MediaType(media_type="text/x-typescript", extension=".ts", authorable=False),
    MediaType(media_type="application/typescript", extension=".ts", authorable=False),
    MediaType(media_type="text/x-python", extension=".py", authorable=False),
    MediaType(media_type="text/x-java", extension=".java", authorable=False),
    MediaType(media_type="text/x-c", extension=".c", authorable=False),
    MediaType(media_type="text/x-c++", extension=".cpp", authorable=False),
    MediaType(media_type="text/x-csharp", extension=".cs", authorable=False),
    MediaType(media_type="text/x-go", extension=".go", authorable=False),
    MediaType(media_type="text/x-rust", extension=".rs", authorable=False),
    MediaType(media_type="text/x-ruby", extension=".rb", authorable=False),
    MediaType(media_type="text/x-php", extension=".php", authorable=False),
    MediaType(media_type="text/x-swift", extension=".swift", authorable=False),
    MediaType(media_type="text/x-kotlin", extension=".kt", authorable=False),
    MediaType(media_type="text/x-shell", extension=".sh", authorable=False),
    MediaType(media_type="application/msword", extension=".doc", authorable=False),
    MediaType(media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension=".docx", authorable=False),
    MediaType(media_type="application/vnd.ms-excel", extension=".xls", authorable=False),
    MediaType(media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension=".xlsx", authorable=False),
    MediaType(media_type="application/vnd.ms-powerpoint", extension=".ppt", authorable=False),
    MediaType(media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation", extension=".pptx", authorable=False),
    MediaType(media_type="application/zip", extension=".zip", authorable=False),
    MediaType(media_type="application/gzip", extension=".gz", authorable=False),
    MediaType(media_type="application/x-tar", extension=".tar", authorable=False),
    MediaType(media_type="application/x-7z-compressed", extension=".7z", authorable=False),
    MediaType(media_type="application/octet-stream", extension=".bin", authorable=False),
    MediaType(media_type="application/wasm", extension=".wasm", authorable=False),
    MediaType(media_type="image/gif", extension=".gif", authorable=False),
    MediaType(media_type="image/webp", extension=".webp", authorable=False),
    MediaType(media_type="image/svg+xml", extension=".svg", authorable=False),
    MediaType(media_type="image/bmp", extension=".bmp", authorable=False),
    MediaType(media_type="image/tiff", extension=".tiff", authorable=False),
    MediaType(media_type="image/x-icon", extension=".ico", authorable=False),
    MediaType(media_type="video/mp4", extension=".mp4", authorable=False),
    MediaType(media_type="video/mpeg", extension=".mpeg", authorable=False),
    MediaType(media_type="video/webm", extension=".webm", authorable=False),
    MediaType(media_type="video/ogg", extension=".ogv", authorable=False),
    MediaType(media_type="video/quicktime", extension=".mov", authorable=False),
    MediaType(media_type="video/x-msvideo", extension=".avi", authorable=False),
    MediaType(media_type="audio/mpeg", extension=".mp3", authorable=False),
    MediaType(media_type="audio/wav", extension=".wav", authorable=False),
    MediaType(media_type="audio/ogg", extension=".ogg", authorable=False),
    MediaType(media_type="audio/webm", extension=".webm", authorable=False),
    MediaType(media_type="audio/aac", extension=".aac", authorable=False),
    MediaType(media_type="audio/flac", extension=".flac", authorable=False),
    MediaType(media_type="font/woff", extension=".woff", authorable=False),
    MediaType(media_type="font/woff2", extension=".woff2", authorable=False),
    MediaType(media_type="font/ttf", extension=".ttf", authorable=False),
    MediaType(media_type="font/otf", extension=".otf", authorable=False),
)
