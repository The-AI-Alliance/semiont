"""White space, held to Unicode's White_Space property: the set the case tables under `specs/src` count by.

The module lists the characters. Here the list is worked out a second way,
from the Unicode data this Python carries, so a character written wrongly in
the list fails.
"""

import sys
import unicodedata
from collections.abc import Iterator

from semiont_worker.white_space import WHITE_SPACE, trimmed


def every_character() -> Iterator[str]:
    return map(chr, range(sys.maxunicode + 1))


def test_the_listed_characters_are_the_ones_unicode_gives_the_property() -> None:
    # The property is every separator (a space, a line or a paragraph one), the five controls from the
    # tab to the carriage return, and the next line.
    separators = {character for character in every_character() if unicodedata.category(character) in ("Zs", "Zl", "Zp")}
    controls = {chr(code_point) for code_point in (*range(0x0009, 0x000E), 0x0085)}
    assert separators | controls == WHITE_SPACE
    assert len(WHITE_SPACE) == 25


def test_python_s_own_white_space_is_these_and_four_separators_more() -> None:
    by_python = {character for character in every_character() if character.isspace()}
    assert by_python - WHITE_SPACE == set("\x1c\x1d\x1e\x1f")
    assert WHITE_SPACE - by_python == set()


def test_a_text_is_trimmed_of_white_space_at_both_ends_and_nowhere_else() -> None:
    assert trimmed("\t\u00a0 a\u2003b \u2029\n") == "a\u2003b"
    assert trimmed(" \u3000 ") == ""
    assert trimmed("") == ""


def test_a_separator_that_is_python_s_white_space_and_not_unicode_s_is_not_trimmed() -> None:
    assert "\x1f a \x1c".strip() == "a"
    assert trimmed("\x1f a \x1c") == "\x1f a \x1c"
