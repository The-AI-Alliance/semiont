"""The rules read from the media types a knowledge base admits.

The table is `specs/src/media-types/registry.json`
(`semiont.media_types_table`), and the rules are the ones
`specs/src/media-types/cases.json` holds in every SDK: the format a clone
takes, the name content is stored under, and where a type's text comes from,
with what follows from that.
"""

from typing import Final, assert_never

from semiont.media_types_table import MEDIA_TYPES, MediaType, TextSource

__all__ = [
    "base_media_type",
    "capabilities_of",
    "clone_format",
    "derives_text_of",
    "storage_file_name",
    "storage_uri",
    "text_source_of",
    "yields_geometry_of",
]

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


def text_source_of(format: str) -> TextSource:
    """Where the text of a resource of `format` comes from. The format's parameters and its case are not read.

    `decode`: its bytes are its text, in some charset. `pdf-text-layer`: its
    text is read out of it by the Smelter, which also says where each run of
    the text is on a page. `none`: it has no text.

    A type the registry has answers as its row says. One it lacks is decoded
    when it is a `text/` type, which is text by what the type says of itself,
    and has no text otherwise.
    """
    row = capabilities_of(format)
    if row is None:
        return "decode" if base_media_type(format).startswith("text/") else "none"
    return row.text_source


def yields_geometry_of(format: str) -> bool:
    """Whether the text of a resource of `format` comes with where each run of it is on a page.

    It follows from where the text comes from: a text read out of a PDF does,
    and one decoded from its bytes does not. Every text source is answered
    here, and one the registry comes to name does not type-check until it is.
    """
    source = text_source_of(format)
    match source:
        case "pdf-text-layer":
            return True
        case "decode" | "none":
            return False
        case _:
            assert_never(source)


def derives_text_of(format: str) -> bool:
    """Whether the text of a resource of `format` is derived from its bytes, by the Smelter, and not decoded from them.

    A reader of a resource's text asks this to know where to read it: a
    derived text is the anchored text's, and a decoded one is
    `semiont.resources.decode_representation`'s, which refuses every other
    type. It is another question than `yields_geometry_of`, though no text
    source yet answers the two differently: a text transcribed from a
    recording would be derived, and on no page.

    Every text source is answered here, and one the registry comes to name
    does not type-check until it is.
    """
    source = text_source_of(format)
    match source:
        case "pdf-text-layer":
            return True
        case "decode" | "none":
            return False
        case _:
            assert_never(source)
