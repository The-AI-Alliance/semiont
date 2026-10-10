"""What a model's reply to a detection is read as: each kind's element, and the passages of the text its elements propose.

A reply arrives as the elements of a JSON array, already parsed: a reply
that could not be read as one was a failure before this. Each element is
judged alone. One that is not as its kind requires is no proposal, and is
passed over. One that is proposes a passage, which is then looked for in the
whole text (`semiont.annotations.reconcile`): the model states no offset,
and what is kept of a passage is the text's own words and the text's own
surroundings, never the model's. A proposal the text does not hold is
counted, because a job reports it.

`specs/src/worker/parser-cases.json` holds the reading. Each element schema
is the one the worker service's suite holds a detection to, its properties in
the suite's order: a provider that holds a reply to a schema writes an
element's members in that order. `prefix` and `suffix` are not required of
an element. Required, a model writes an empty one where it would have left
the member out.
"""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, final

from pydantic import JsonValue
from semiont.annotations import QuotedText, ReconciledSpan, TextSpan, reconcile
from semiont_inference.interface import ElementSchema

from semiont_worker.detection.anchor_audit import note_anchor
from semiont_worker.log import LOG
from semiont_worker.telemetry import DetectionLabel
from semiont_worker.white_space import trimmed

HIGHLIGHT_ELEMENT_SCHEMA: Final[ElementSchema] = {
    "type": "object",
    "properties": {"exact": {"type": "string"}, "prefix": {"type": "string"}, "suffix": {"type": "string"}},
    "required": ["exact"],
    "additionalProperties": False,
}
"""One element of a highlighting reply: a passage."""

COMMENT_ELEMENT_SCHEMA: Final[ElementSchema] = {
    "type": "object",
    "properties": {"exact": {"type": "string"}, "comment": {"type": "string"}, "prefix": {"type": "string"}, "suffix": {"type": "string"}},
    "required": ["exact", "comment"],
    "additionalProperties": False,
}
"""One element of a commenting reply: a passage, and what the model says of it."""

ASSESSMENT_ELEMENT_SCHEMA: Final[ElementSchema] = {
    "type": "object",
    "properties": {
        "exact": {"type": "string"},
        "assessment": {"type": "string"},
        "prefix": {"type": "string"},
        "suffix": {"type": "string"},
    },
    "required": ["exact", "assessment"],
    "additionalProperties": False,
}
"""One element of an assessing reply: a passage, and the model's judgement of it."""

TAG_ELEMENT_SCHEMA: Final[ElementSchema] = {
    "type": "object",
    "properties": {"exact": {"type": "string"}, "prefix": {"type": "string"}, "suffix": {"type": "string"}},
    "required": ["exact"],
    "additionalProperties": False,
}
"""One element of a tagging reply: a passage. Its category is the one the call was for, and the model writes none."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class CommentMatch(TextSpan):
    """A passage of the text, and what the model says of it, as written."""

    comment: str


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class AssessmentMatch(TextSpan):
    """A passage of the text, and the model's judgement of it, as written."""

    assessment: str


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class TagMatch(TextSpan):
    """A passage of the text, and the category the call that found it was for."""

    category: str


@final
@dataclass(frozen=True, slots=True)
class Anchored[M]:
    """What became of a reply's proposals: the passages found in the text, and how many proposals were found nowhere.

    The second is counted because a job reports it as its errors. Dropped
    without a count, the job would report what survived as what the model
    proposed.
    """

    matches: list[M]
    dropped: int


def quoted_of(element: JsonValue) -> QuotedText | None:
    """The words an element quotes from the text, and what it says stands beside them.

    Nothing for an element that is no JSON object, and for one whose `exact`
    is not text. Its `prefix` and its `suffix` are read only where they are
    text, and nothing else it carries is read at all.
    """
    if not isinstance(element, dict):
        return None
    exact, prefix, suffix = element.get("exact"), element.get("prefix"), element.get("suffix")
    if not isinstance(exact, str):
        return None
    return QuotedText(exact=exact, prefix=prefix if isinstance(prefix, str) else None, suffix=suffix if isinstance(suffix, str) else None)


def _said_of(element: JsonValue, member: str) -> tuple[QuotedText, str] | None:
    """The words an element quotes, and what it says of them under `member`. Nothing unless that is text that is not blank."""
    quoted = quoted_of(element)
    if quoted is None or not isinstance(element, dict):
        return None
    said = element.get(member)
    if not isinstance(said, str) or not trimmed(said):
        return None
    return quoted, said


def _anchored[S, M](
    text: str,
    proposals: Sequence[tuple[QuotedText, S]],
    label: DetectionLabel,
    of: Mapping[str, str],
    match: Callable[[ReconciledSpan, S], M],
) -> Anchored[M]:
    """Look for each proposal's words in `text`, and make of each one found what `match` makes of its span and of what was said of it.

    `label` is what an anchor is counted under, and `of` what is said with a
    proposal that is found nowhere: whose it was.
    """
    matches: list[M] = []
    for quoted, said in proposals:
        found = reconcile(text, quoted)
        if found is None:
            LOG.warning("Proposal dropped — text not found in source", extra={**of, "text": quoted.exact})
            continue
        note_anchor(label, quoted.exact, found.anchor_method)
        matches.append(match(found, said))
    return Anchored(matches=matches, dropped=len(proposals) - len(matches))


def read_highlights(elements: Sequence[JsonValue], text: str) -> Anchored[TextSpan]:
    """The passages of `text` a highlighting reply proposes. A highlight is the passage alone."""
    proposals = [(quoted, None) for element in elements if (quoted := quoted_of(element)) is not None]
    return _anchored(
        text,
        proposals,
        "highlight",
        {"motivation": "highlighting"},
        lambda found, _: TextSpan(start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix),
    )


def read_comments(elements: Sequence[JsonValue], text: str) -> Anchored[CommentMatch]:
    """The passages of `text` a commenting reply proposes, each with its comment. An element with a blank one proposes nothing."""
    proposals = [said for element in elements if (said := _said_of(element, "comment")) is not None]
    LOG.debug("Read the proposals of a reply", extra={"motivation": "commenting", "proposals": len(proposals), "elements": len(elements)})
    return _anchored(
        text,
        proposals,
        "comment",
        {"motivation": "commenting"},
        lambda found, comment: CommentMatch(
            start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix, comment=comment
        ),
    )


def read_assessments(elements: Sequence[JsonValue], text: str) -> Anchored[AssessmentMatch]:
    """The passages of `text` an assessing reply proposes, each with its assessment. An element with a blank one proposes nothing."""
    proposals = [said for element in elements if (said := _said_of(element, "assessment")) is not None]
    return _anchored(
        text,
        proposals,
        "assessment",
        {"motivation": "assessing"},
        lambda found, assessment: AssessmentMatch(
            start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix, assessment=assessment
        ),
    )


def read_tags(elements: Sequence[JsonValue], text: str, category: str) -> Anchored[TagMatch]:
    """The passages of `text` a tagging reply proposes, each given `category`, which the call was for: one the model names is not read."""
    proposals = [(quoted, None) for element in elements if (quoted := quoted_of(element)) is not None]
    LOG.debug("Read the proposals of a reply", extra={"motivation": "tagging", "proposals": len(proposals), "elements": len(elements)})
    return _anchored(
        text,
        proposals,
        "tag",
        {"motivation": "tagging", "category": category},
        lambda found, _: TagMatch(
            start=found.start, end=found.end, exact=found.exact, prefix=found.prefix, suffix=found.suffix, category=category
        ),
    )
