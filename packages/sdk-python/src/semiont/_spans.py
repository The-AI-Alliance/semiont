"""A span of a text, and finding the one a model quoted.

A model asked to mark a text quotes it, and nothing it says is trusted.
`reconcile` finds the quoted words in the text and answers a span that is the
text's own, or nothing. `specs/src/annotations/reconcile-cases.json` holds the
rule, for this and for every other SDK.

An offset counts Unicode code points from the start of the text, and so does
every length a rule here states. A `str` is indexed by code point, so an
offset is a string's own index and a length is `len`: nothing is converted.
"""

from dataclasses import dataclass
from typing import Final, Literal, final

from semiont._white_space import WHITE_SPACE, trimmed

type AnchorMethod = Literal["unique-match", "context-recovered", "first-of-many", "fuzzy-match"]
"""How a span was found.

The text has the words once; it has them more than once and the model's hints
chose; it has them more than once and nothing chose, so the first was taken;
or it does not have them as quoted, and a looser search found them.
"""

type MatchQuality = Literal["normalized", "case-insensitive", "fuzzy"]
"""Which looser search found a span.

Without regard to white space and the forms of quotation marks and dashes,
without regard to letter case, or by edits within the allowance.
"""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class QuotedText:
    """The words a model quoted from a text, and what it says stands beside them.

    `prefix` and `suffix` are hints of which place is meant, where the text has
    the words in more than one. Neither is kept: a span's context is the text's.
    """

    exact: str
    prefix: str | None = None
    suffix: str | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class TextSpan:
    """A span of a text: the code points from `start` up to but not including `end`.

    `exact` is the words there, and `prefix` and `suffix` what the text has
    just before and just after them.
    """

    start: int
    end: int
    exact: str
    prefix: str | None = None
    suffix: str | None = None


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class ReconciledSpan(TextSpan):
    """A span `reconcile` found, which is the text's own, and how it was found.

    `match_quality` names the looser search, when `anchor_method` is `fuzzy-match`.
    """

    anchor_method: AnchorMethod
    match_quality: MatchQuality | None = None


type _Place = tuple[int, int]
"""A span of the text as its two offsets."""

_CONTEXT: Final = 64
"""How many code points of the text a prefix or a suffix is."""
_LENGTHENED_BY_AT_MOST: Final = 32
"""How many more it may take to begin or end at a boundary."""
_BOUNDARY: Final = WHITE_SPACE | frozenset(".,;:!?'\"()[]{}<>/\\")
"""What a context is not lengthened past: white space, or one of eighteen marks."""
_HINT_REACH: Final = 32
"""The least number of code points beside a place that a hint is looked for in."""
_PLAIN: Final = {"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2014": "--", "\u2013": "-"}
"""The plain form of each quotation mark and dash that has one."""
_ALLOWED_EDITS_ONE_IN: Final = 20
"""The loose search allows one edit for each twenty code points of the quote."""


def places(text: str, words: str) -> list[int]:
    """Every place `text` has `words`, as the offset each starts at, in the text's order. Places may overlap."""
    found: list[int] = []
    at = text.find(words)
    while at != -1:
        found.append(at)
        at = text.find(words, at + 1)
    return found


def _context_of(text: str, place: _Place) -> tuple[str | None, str | None]:
    """The text just before a place and just after it: nothing on a side where the text has nothing."""
    start, end = place
    prefix: str | None = None
    if start > 0:
        begins = max(0, start - _CONTEXT)
        furthest = max(0, begins - _LENGTHENED_BY_AT_MOST)
        while begins > furthest and text[begins - 1] not in _BOUNDARY:
            begins -= 1
        prefix = text[begins:start]
    suffix: str | None = None
    if end < len(text):
        ends = min(len(text), end + _CONTEXT)
        furthest = min(len(text), ends + _LENGTHENED_BY_AT_MOST)
        while ends < furthest and text[ends] not in _BOUNDARY:
            ends += 1
        suffix = text[end:ends]
    return prefix, suffix


def _normalized(text: str) -> tuple[str, list[int]]:
    """`text` normalized, and for each code point of the result the offset in `text` of the character it came from.

    Every run of white space is one space, counted from where the run began,
    and there is none at the two ends. A quotation mark or a dash is its plain
    form: an em dash is two hyphens, and both came from the dash.
    """
    written: list[str] = []
    came_from: list[int] = []
    run_began: int | None = None
    for offset, character in enumerate(text):
        if character in WHITE_SPACE:
            if run_began is None:
                run_began = offset
            continue
        if run_began is not None:
            if written:
                written.append(" ")
                came_from.append(run_began)
            run_began = None
        plain = _PLAIN.get(character, character)
        written.append(plain)
        came_from.extend([offset] * len(plain))
    return "".join(written), came_from


def _lower_cased(text: str) -> tuple[str, list[int]]:
    """`text` in lower case, and for each code point of the result the offset in `text` of the character it came from.

    The text is lower-cased whole, by Unicode's rule of no language: a capital
    sigma that ends a word becomes the final one, which a character at a time
    would miss. A character becomes as many code points whole as alone (a
    capital I with a dot becomes two), and that is what the offsets are
    counted from.
    """
    lowered = text.lower()
    came_from = [offset for offset, character in enumerate(text) for _ in character.lower()]
    if len(came_from) != len(lowered):
        raise RuntimeError("a text lower-cased whole is not as long as its characters lower-cased one at a time")
    return lowered, came_from


def _came_from(came_from: list[int], found: list[int], length: int) -> list[_Place]:
    """The places of the text that matches in a changed copy of it came from: each `length` code points of the copy.

    A place starts at the character its first code point came from and ends
    just after the one its last came from. So a character that became several
    code points is in the place whole, and white space after a match is not.
    """
    return [(came_from[at], came_from[at + length - 1] + 1) for at in found]


def _distances_from(wanted: str, text: str, start: int, longest: int, allowance: int) -> list[int] | None:
    """The edit distance from `wanted` to each stretch of `text` at `start` that is within `allowance` of it in length.

    The distance to the stretch of `len(wanted) - allowance + n` code points
    is at `[n]`; one past `longest` is beyond the allowance. Nothing when no
    stretch from `start` is within the allowance.

    A distance is at least the difference of the two lengths. So of each row
    of the table of distances, only the stretches that near in length to what
    of `wanted` has been taken can be within the allowance, and only those are
    worked out. A distance beyond the allowance is held as one more than it,
    whatever it is.
    """
    beyond = allowance + 1
    # After `taken` code points of `wanted`, the stretch of `length` is at [length - taken + allowance + 1]; the two ends stay beyond.
    width = 2 * allowance + 3
    row = [beyond] * width
    for length in range(min(allowance, longest) + 1):
        row[length + allowance + 1] = length
    for taken in range(1, len(wanted) + 1):
        above, row = row, [beyond] * width
        letter = wanted[taken - 1]
        least = beyond
        for length in range(max(0, taken - allowance), min(longest, taken + allowance) + 1):
            at = length - taken + allowance + 1
            if length == 0:
                # Against no text at all, every code point taken is one deleted.
                distance = taken
            else:
                replaced = 0 if letter == text[start + length - 1] else 1
                distance = min(above[at + 1] + 1, row[at - 1] + 1, above[at] + replaced, beyond)
            row[at] = distance
            least = min(least, distance)
        # The least distance of a row never falls as more of `wanted` is taken.
        if least > allowance:
            return None
    return row[1:-1]


def nearest_stretch(text: str, exact: str) -> _Place | None:
    """The stretch of `text` at the least edit distance from `exact`, when that is within the allowance.

    The allowance is a twentieth of `exact`'s code points, rounded down, with
    no minimum. Of several stretches at the least distance it is the first in
    the text; of those that begin at one place, the nearest `exact` in length;
    and of two as near, the shorter.
    """
    size = len(exact)
    allowance = size // _ALLOWED_EDITS_ONE_IN
    # A stretch at no distance is `exact` itself, which the text was searched for before this.
    if allowance == 0:
        return None
    # From each start: the stretch as long as `exact`, then a code point shorter, a code point longer, and so on out.
    nearest_in_length_first = [size, *(size + way * away for away in range(1, allowance + 1) for way in (-1, 1))]
    best: tuple[int, _Place] | None = None
    for start in range(len(text) - (size - allowance) + 1):
        distances = _distances_from(exact, text, start, min(size + allowance, len(text) - start), allowance)
        if distances is None:
            continue
        for length in nearest_in_length_first:
            distance = distances[length - size + allowance]
            if distance <= allowance and (best is None or distance < best[0]):
                best = (distance, (start, start + length))
    return None if best is None else best[1]


def _looser(text: str, exact: str) -> tuple[list[_Place], MatchQuality] | None:
    """The places the first looser search that finds any finds, in the text's order, and which search it was."""
    normal, came_from = _normalized(text)
    wanted, _ = _normalized(exact)
    found = places(normal, wanted)
    if found:
        return _came_from(came_from, found, len(wanted)), "normalized"

    lowered, came_from = _lower_cased(text)
    wanted = exact.lower()
    found = places(lowered, wanted)
    if found:
        return _came_from(came_from, found, len(wanted)), "case-insensitive"

    nearest = nearest_stretch(text, exact)
    return None if nearest is None else ([nearest], "fuzzy")


def _hint(given: str | None) -> str | None:
    """What a model says stands beside the words, when it is more than white space: a hint of where."""
    return None if given is None or not trimmed(given) else given


def _fits(text: str, place: _Place, prefix: str | None, suffix: str | None) -> bool:
    """Whether the text around a place carries every hint given.

    A hint is looked for in as many code points beside the place as the hint
    has, and at least `_HINT_REACH`. It fits when the text there has it
    anywhere, the white space at the hint's own two ends removed. A hint the
    text meets the place with is one it has there, so the rule's other way to
    fit is this one too.
    """
    start, end = place
    if prefix is not None and trimmed(prefix) not in text[max(0, start - max(_HINT_REACH, len(prefix))) : start]:
        return False
    return suffix is None or trimmed(suffix) in text[end : end + max(_HINT_REACH, len(suffix))]


def _hinted(text: str, found: list[_Place], prefix: str | None, suffix: str | None) -> _Place | None:
    """The first of several places that fits every hint given. Nothing when no hint was given, and when no place fits."""
    if prefix is None and suffix is None:
        return None
    return next((place for place in found if _fits(text, place, prefix, suffix)), None)


def _reconciled(text: str, place: _Place, anchor_method: AnchorMethod, match_quality: MatchQuality | None = None) -> ReconciledSpan:
    """A place as the span it is: its words and its context are the text's, never the model's spelling of them."""
    start, end = place
    prefix, suffix = _context_of(text, place)
    return ReconciledSpan(
        start=start, end=end, exact=text[start:end], prefix=prefix, suffix=suffix, anchor_method=anchor_method, match_quality=match_quality
    )


def reconcile(text: str, quoted: QuotedText) -> ReconciledSpan | None:
    """Find the words a model quoted in `text`.

    The span answered is the text's own: its `exact` is the text between its
    offsets, and its `prefix` and `suffix` are what the text has on either
    side. It goes to `annotation_of_span` as it is.

    Nothing is answered for a quote that is empty or only white space, and for
    words the text has nowhere, by any of the searches.
    """
    exact = quoted.exact
    if not trimmed(exact):
        return None
    prefix, suffix = _hint(quoted.prefix), _hint(quoted.suffix)

    found: list[_Place] = [(start, start + len(exact)) for start in places(text, exact)]
    if len(found) == 1:
        return _reconciled(text, found[0], "unique-match")
    if found:
        chosen = _hinted(text, found, prefix, suffix)
        if chosen is not None:
            return _reconciled(text, chosen, "context-recovered")
        return _reconciled(text, found[0], "first-of-many")

    looser = _looser(text, exact)
    if looser is None:
        return None
    found, match_quality = looser
    chosen = _hinted(text, found, prefix, suffix)
    return _reconciled(text, found[0] if chosen is None else chosen, "fuzzy-match", match_quality)
