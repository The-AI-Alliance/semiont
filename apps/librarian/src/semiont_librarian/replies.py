"""What a Librarian reads from a model's reply: the scores a score prompt asked for, and the suggestions a suggestions prompt asked for.

`docs/protocol/LIBRARIAN.md` § The model's score and § Gathering around a
resource state the two readings, and `specs/src/librarian/reply-cases.json`
is the rule. A reply is read a line at a time, the lines parted by a line
feed. A line that gives nothing is no error: a reply is a model's, and is
read for what it has.

White space is what Unicode gives the White_Space property
(`semiont_service.white_space`). A number is written in the digits 0 to 9.
"""

import re
from typing import Final

from semiont_service.white_space import WHITE_SPACE, trimmed

__all__ = ["read_scores", "read_suggestions"]

_SPACE: Final = "[" + re.escape("".join(sorted(WHITE_SPACE))) + "]*"
"""Any white space, or none, as a pattern."""

_SCORED: Final = re.compile(r"([0-9]+)\." + _SPACE + r"([0-9.]+)")
"""What a line that scores a candidate starts with: a number, a full stop, any white space, and a score in digits and full stops."""

_BULLET: Final = re.compile(r"^[-*\N{BULLET}]" + _SPACE)
"""A bullet that starts a line, a hyphen, an asterisk or a round bullet, with the white space after it."""

_SUGGESTIONS: Final = 3
"""The most suggestions read from a reply."""


def read_scores(reply: str, candidates: int) -> dict[int, float]:
    """The score a reply to a score prompt gives each candidate, by the candidate's number in the prompt, which counts from 1.

    `candidates` is how many the prompt listed. The white space at the two
    ends of the reply is dropped, and what is left is read a line at a time.
    A line gives a score when it starts with the number of one of the
    candidates, a full stop, and a score from 0 to 1, both ends included.
    What follows the score on its line is not read. Where two lines score
    one candidate, the later is read. A candidate no line scores is not in
    the answer.

    A score that is no number, full stops alone or `0.8.5`, gives nothing:
    its line is dropped.
    """
    scores: dict[int, float] = {}
    for line in trimmed(reply).split("\n"):
        found = _SCORED.match(line)
        if found is None:
            continue
        try:
            number, score = int(found.group(1)), float(found.group(2))
        except ValueError:
            # Digits and full stops that are no number, or a number of more digits than Python reads as one.
            continue
        if 1 <= number <= candidates and 0 <= score <= 1:
            scores[number] = score
    return scores


def read_suggestions(reply: str) -> list[str] | None:
    """The suggestions a reply to a reference-suggestions prompt gives: its first three lines that are not empty.

    A bullet that starts a line is dropped with the white space after it,
    and then the white space at the two ends of the line. A line with
    nothing left is dropped. The empty reply answers `None`, which is no
    suggestions at all; a reply that is not empty and has nothing on its
    lines answers an empty list.
    """
    if reply == "":
        return None
    lines = (trimmed(_BULLET.sub("", line)) for line in reply.split("\n"))
    return [line for line in lines if line][:_SUGGESTIONS]
