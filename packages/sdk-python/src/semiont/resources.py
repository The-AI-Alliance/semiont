"""Reading a resource: its description, and the text its bytes are.

A resource's `representations` is one representation or a list of them, and
its `entityTypes` may be left out. The readers read each, so that nothing
that reads a resource narrows those shapes by hand. `decode_representation`
makes a text of the bytes of a resource whose bytes are its text: it is what
`client.browse.resource_content` reads with.

Every SDK has these. The case tables hold each to one answer:
`specs/src/resources/reader-cases.json` the readers, and
`specs/src/text/decode-cases.json` with `specs/src/text/encoding-cases.json`
the text. This package's tests run them.
"""

import string
from typing import Final

from semiont._encodings import ENCODING_OF_LABEL, REFUSED, SINGLE_BYTE
from semiont.errors import TransportError
from semiont.media_types import base_media_type, derives_text_of, text_source_of
from semiont.types import Representation, ResourceDescriptor

__all__ = ["decode_representation", "primary_media_type", "primary_representation", "resource_entity_types"]


def primary_representation(resource: ResourceDescriptor) -> Representation | None:
    """A resource's primary representation: its one, or the first of its list. Nothing for a resource with none."""
    stated = resource.representations
    if isinstance(stated, Representation):
        return stated
    return stated[0] if stated else None


def primary_media_type(resource: ResourceDescriptor) -> str | None:
    """The media type of a resource's primary representation. Nothing for a resource with none."""
    representation = primary_representation(resource)
    return None if representation is None else representation.media_type


def resource_entity_types(resource: ResourceDescriptor) -> list[str]:
    """The entity types a resource states, in the order it states them: none for a resource that states none."""
    return [] if resource.entity_types is None else list(resource.entity_types)


# What a content type is made of, as the MIME Sniffing Standard reads one:
# its white space, and the characters of a type, a subtype and a parameter's
# name.
_HTTP_WHITE_SPACE: Final = "\n\r\t "
_HTTP_TOKEN: Final = frozenset("!#$%&'*+-.^_`|~" + string.digits + string.ascii_letters)

# What the Encoding Standard drops from around a label, and the case it
# matches one in.
_ASCII_WHITE_SPACE: Final = "\t\n\f\r "
_ASCII_LOWER: Final = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)

# The byte-order marks, each with Python's decoder of the encoding it is
# the mark of, in the order the Encoding Standard looks for them.
_MARKS: Final = ((b"\xef\xbb\xbf", "utf-8"), (b"\xfe\xff", "utf-16-be"), (b"\xff\xfe", "utf-16-le"))

# The encodings Python's own decoders read as the standard's do, malformed
# input included: specs/src/text/decode-cases.json holds them to it.
_PYTHONS_OWN: Final = {"utf-8": "utf-8", "utf-16be": "utf-16-be", "utf-16le": "utf-16-le"}

# The standard's legacy multi-byte encodings, each by Python's codec of the
# decoder the standard names for it: GBK's is gb18030's, and each other is the
# superset of what its name says that the standard reads (Big5-HKSCS,
# windows-949, windows-31j). Every label of each is the encoding's, whatever
# codec Python would look the label up as. specs/src/text/encoding-cases.json
# holds every label of each.
_LEGACY_MULTI_BYTE: Final = {
    "big5": "big5hkscs",
    "euc-jp": "euc_jp",
    "euc-kr": "cp949",
    "gb18030": "gb18030",
    "gbk": "gb18030",
    "iso-2022-jp": "iso2022_jp",
    "shift_jis": "cp932",
}


def _is_http_token(text: str) -> bool:
    return text != "" and all(character in _HTTP_TOKEN for character in text)


def _is_of_a_parameter_value(character: str) -> bool:
    """Whether a parameter's value may hold it: a tab, U+0020 to U+007E, and U+0080 to U+00FF."""
    return character == "\t" or " " <= character <= "~" or "\x80" <= character <= "\xff"


def _quoted_string(text: str, start: int) -> tuple[str, int]:
    """The quoted string that opens at `start`, without its quotation marks, and where it ends."""
    position = start + 1
    value: list[str] = []
    while True:
        opened = position
        while position < len(text) and text[position] not in '"\\':
            position += 1
        value.append(text[opened:position])
        if position >= len(text):
            break
        mark = text[position]
        position += 1
        if mark == '"':
            break
        # A backslash gives the character after it, and at the very end is itself.
        if position >= len(text):
            value.append("\\")
            break
        value.append(text[position])
        position += 1
    return "".join(value), position


def _charset(content_type: str) -> str | None:
    """The value of a content type's `charset` parameter, as the MIME Sniffing Standard parses a MIME type.

    The first parameter of that name that is one. None where there is none,
    and where the content type is no MIME type.
    """
    text = content_type.strip(_HTTP_WHITE_SPACE)
    kind, slash, rest = text.partition("/")
    if slash == "" or not _is_http_token(kind):
        return None
    subtype = rest.partition(";")[0]
    if not _is_http_token(subtype.rstrip(_HTTP_WHITE_SPACE)):
        return None
    position = len(kind) + 1 + len(subtype)
    while position < len(text):
        position += 1  # past the semicolon
        while position < len(text) and text[position] in _HTTP_WHITE_SPACE:
            position += 1
        opened = position
        while position < len(text) and text[position] not in ";=":
            position += 1
        name = text[opened:position].translate(_ASCII_LOWER)
        if position < len(text):
            if text[position] == ";":
                continue
            position += 1  # past the equals sign
        if position >= len(text):
            break
        if text[position] == '"':
            value, position = _quoted_string(text, position)
            while position < len(text) and text[position] != ";":
                position += 1
        else:
            opened = position
            while position < len(text) and text[position] != ";":
                position += 1
            value = text[opened:position].rstrip(_HTTP_WHITE_SPACE)
            if value == "":
                continue
        if name == "charset" and all(_is_of_a_parameter_value(character) for character in value):
            return value
    return None


def _stated_encoding(content_type: str) -> str | None:
    """The encoding a content type states. None where it states none, or an empty one.

    It is stated by a label of the Encoding Standard, read in lower case and
    without the white space around it. One the standard lacks is refused, and
    so is one of an encoding it reads no text under.
    """
    stated = _charset(content_type)
    if stated is None or stated == "":
        return None
    label = stated.strip(_ASCII_WHITE_SPACE).translate(_ASCII_LOWER)
    encoding = ENCODING_OF_LABEL.get(label)
    if encoding is None or encoding in REFUSED:
        raise TransportError(
            "error", f"The resource's text is {stated}, which is no charset the Encoding Standard decodes: read its bytes instead"
        )
    return encoding


def decode_representation(data: bytes, media_type: str) -> str:
    """Bytes as the text they are, by the rule every reader of a resource's text keeps.

    `media_type` is the content type the bytes came with: the type, and the
    charset it states.

    Only a type whose bytes are its text is read. One whose text is derived
    from its bytes (a PDF) is refused, and so is one that has no text (an
    image), before its charset is read and whatever the bytes are: nothing
    that was never text is read as text. The refusal names the media type,
    without its parameters and in lower case. Where a type's text comes from,
    `semiont.media_types.text_source_of` says, so a `text/` type the registry
    lacks is read.

    The rule is `docs/protocol/W3C-SELECTORS.md`'s ("The text of a
    resource"): the MIME Sniffing Standard's reading of the content type and
    the Encoding Standard's reading of the bytes, as a browser follows the
    two. The charset is the one the content type states, UTF-8 when it states
    none, and is a label of the Encoding Standard: any other is refused,
    whatever the bytes are. Bytes that begin with the byte-order mark of
    UTF-8, UTF-16BE or UTF-16LE are in that encoding, whatever was stated,
    and the mark is not part of the text. What the encoding does not have is
    U+FFFD. A refusal names the charset: nothing is read as something it is
    not, and the bytes are there to read
    (`client.browse.resource_representation`).

    Each refusal is a `TransportError` whose code is `error`.

    The labels and the single-byte encodings are the standard's, from the
    table generated of it (`semiont._encodings`), and not Python's own, which
    differ from it. The legacy multi-byte encodings are read by Python's codec
    of the decoder the standard names for each, whatever the label.
    """
    base = base_media_type(media_type)
    if derives_text_of(media_type):
        raise TransportError(
            "error", f"The resource is {base}, whose text is derived from its bytes, not decoded: read its anchored text instead"
        )
    if text_source_of(media_type) == "none":
        raise TransportError("error", f"The resource is {base}, which has no text: read its bytes instead")
    encoding = _stated_encoding(media_type)
    for mark, decoder in _MARKS:
        if data.startswith(mark):
            return data[len(mark) :].decode(decoder, "replace")
    if encoding is None:
        return data.decode("utf-8", "replace")
    if encoding in _PYTHONS_OWN:
        return data.decode(_PYTHONS_OWN[encoding], "replace")
    if encoding in SINGLE_BYTE:
        return data.decode("latin-1").translate(SINGLE_BYTE[encoding])
    # What is left is the standard's legacy multi-byte encodings.
    return data.decode(_LEGACY_MULTI_BYTE[encoding], "replace")
