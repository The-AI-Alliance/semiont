"""White space, as the case tables under `specs/src` count it: what Unicode gives the White_Space property.

Python's own is another set. `str.isspace`, and so a bare `str.strip`, also
takes the four separators U+001C to U+001F, which do not have the property.
So white space is asked of this module, and of nothing a string was born with.
"""

from typing import Final

WHITE_SPACE: Final = frozenset(
    map(chr, (*range(0x0009, 0x000E), 0x0020, 0x0085, 0x00A0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000))
)
"""The twenty-five characters with the White_Space property."""

_EVERY: Final = "".join(sorted(WHITE_SPACE))


def trimmed(text: str) -> str:
    """`text` without the white space at its two ends."""
    return text.strip(_EVERY)
