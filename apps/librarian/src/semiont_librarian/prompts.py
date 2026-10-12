"""The five prompts a Librarian sends a model: each made from plain values, with the token limit and the temperature it is sent with.

`docs/protocol/LIBRARIAN.md` § The prompts states them, and
`specs/src/librarian/prompt-cases.json` is the rule: what each prompt is made
from, and its text to the last character. A function here takes what the
table says its prompt is made from, by the table's names, and answers the
prompt. It reads no store and asks no model.

What a prompt may be given is bounded where the prompt is made, so whoever
makes one hands over all it has: every candidate, every connected resource,
the whole of a text. A cut of a text counts Unicode code points.

Lines are parted by a line feed, and a prompt ends with none.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Protocol, final

from semiont_inference.interface import InferenceClient

__all__ = [
    "Candidate",
    "Listed",
    "Prompt",
    "after_passage",
    "annotation_summary_prompt",
    "ask",
    "before_passage",
    "reference_suggestions_prompt",
    "relationship_prompt",
    "resource_summary_prompt",
    "score_prompt",
]

_CANDIDATES: Final = 20
"""The most candidates a score prompt lists."""

_CONNECTED_FOR_A_SCORE: Final = 5
"""The most connected resources a score prompt names."""

_CONNECTED: Final = 10
"""The most connected resources a relationship prompt names."""

_CITING: Final = 5
"""The most citing resources a relationship prompt names."""

_SIBLINGS: Final = 10
"""The most sibling entity types a relationship prompt names."""

_CONTENT: Final = 2000
"""The most of a resource's text a resource-summary prompt has."""

_STUB: Final = 500
"""The most of a stub a reference-suggestions prompt has."""

_NEAR: Final = 200
"""The most text on each side of a passage an annotation-summary prompt has."""

_BODY_LABELS: Final = {"commenting": "Comment", "assessing": "Assessment"}
"""The motivations whose body's text is a line of a score prompt, each with the label of its line."""


@final
@dataclass(frozen=True, slots=True)
class Prompt:
    """A prompt: its text, and the token limit and the temperature it is sent with."""

    text: str
    max_tokens: int
    temperature: float


class Listed(Protocol):
    """A candidate, as a score prompt lists one: its id, its name and its entity types.

    A resource's description is one, and so is a `Candidate`.
    """

    @property
    def id(self) -> str: ...

    @property
    def name(self) -> str: ...

    @property
    def entity_types(self) -> Sequence[str] | None: ...


@final
@dataclass(frozen=True, slots=True)
class Candidate:
    """A candidate stated as the three things a score prompt lists of it, by whoever has no description of it."""

    id: str
    name: str
    entity_types: tuple[str, ...]


async def ask(model: InferenceClient, prompt: Prompt) -> str:
    """A model's reply to a prompt, which is sent with the prompt's own token limit and temperature."""
    return (await model.generate_text(prompt.text, prompt.max_tokens, prompt.temperature)).text


def before_passage(text: str) -> str:
    """The end of the text before a passage: the last 200 of it, which is what an annotation's summary has."""
    return text[max(0, len(text) - _NEAR) :]


def after_passage(text: str) -> str:
    """The start of the text after a passage: the first 200 of it, which is what an annotation's summary has."""
    return text[:_NEAR]


def _listed(names: Sequence[str]) -> str:
    """A list of names or of entity types, as every prompt writes one."""
    return ", ".join(names)


def _lines(lines: Sequence[str]) -> str:
    """Lines, each parted from the next by a line feed, with none after the last."""
    return "\n".join(lines)


def score_prompt(
    *,
    motivation: str,
    source: str,
    entity_types: Sequence[str],
    connected: Sequence[str],
    candidates: Sequence[Listed],
    selected: str | None = None,
    hint: str | None = None,
    body: str | None = None,
    relationship: str | None = None,
) -> Prompt:
    """The prompt that asks how well each candidate answers a reference.

    `selected` is the text the annotation selects and `hint` what its author
    typed to say what is meant: each is left out when it is absent or empty.
    The passage is the two with an em dash between them, and the search term
    the two with a space. `motivation` is the annotation's and `source` the
    name of its resource. `body` is the text of the annotation's body, and is
    a line only for a comment or an assessment that has one. `entity_types`
    are the annotation's, `connected` the names of the resources its resource
    is connected to, of which the first five are named, and `relationship`
    the relationship sentence gathered for it. Of `candidates` the first
    twenty are listed, numbered from 1 in the order given, and one with no
    entity types is listed with `none`.
    """
    said = [part for part in (selected, hint) if part]
    passage, term = " \N{EM DASH} ".join(said), " ".join(said)
    context = [f"Annotation motivation: {motivation}", f"Source resource: {source}"]
    if body and motivation in _BODY_LABELS:
        context.append(f"{_BODY_LABELS[motivation]}: {body}")
    if entity_types:
        context.append(f"Annotation entity types: {_listed(entity_types)}")
    if connected:
        context.append(f"Connected resources: {_listed(connected[:_CONNECTED_FOR_A_SCORE])}")
    if relationship:
        context.append(f"Relationship context: {relationship}")
    lines: list[str] = []
    for number, candidate in enumerate(candidates[:_CANDIDATES], start=1):
        types = _listed(candidate.entity_types or ()) or "none"
        lines.append(f'{number}. "{candidate.name}" (id: {candidate.id}, types: {types})')
    text = (
        "Given this passage and context, score each candidate resource's semantic relevance on a scale of 0.0 to 1.0.\n"
        "\n"
        f'Passage: "{passage}"\n'
        f'Search term: "{term}"\n'
        f"{_lines(context)}\n"
        "\n"
        "Candidates:\n"
        f"{_lines(lines)}\n"
        "\n"
        "For each candidate, output a line with the number and score, like:\n"
        "1. 0.8\n"
        "2. 0.3"
    )
    return Prompt(text, max_tokens=200, temperature=0.1)


def relationship_prompt(
    *,
    passage: str,
    connected: Sequence[str],
    cited_by: Sequence[str],
    sibling_entity_types: Sequence[str],
    entity_types: Sequence[str],
) -> Prompt:
    """The prompt that asks for the sentence that says how a passage relates to what is around it.

    `passage` is the text the annotation selects. `connected` are the names
    of the resources its resource is connected to, of which the first ten are
    named; `cited_by` the names of the resources that cite its resource, the
    first five; `sibling_entity_types` the entity types of the other
    annotations on its resource, the first ten. `entity_types` are the
    annotation's own, and all are named. A list with nothing in it has no
    line.
    """
    parts = [f'Passage: "{passage}"']
    if connected:
        parts.append(f"Connected resources: {_listed(connected[:_CONNECTED])}")
    if cited_by:
        parts.append(f"Cited by: {_listed(cited_by[:_CITING])}")
    if sibling_entity_types:
        parts.append(f"Sibling entity types: {_listed(sibling_entity_types[:_SIBLINGS])}")
    if entity_types:
        parts.append(f"Annotation entity types: {_listed(entity_types)}")
    text = (
        "Given this annotation passage and its knowledge graph neighborhood, write a 1-2 sentence summary of how this passage "
        "relates to its surrounding resources and what kind of resource would best resolve this reference.\n"
        "\n"
        f"{_lines(parts)}\n"
        "\n"
        "Summary:"
    )
    return Prompt(text, max_tokens=150, temperature=0.3)


def resource_summary_prompt(*, name: str, content: str, entity_types: Sequence[str]) -> Prompt:
    """The prompt that asks for a summary of a resource.

    `name` is the resource's name, `content` its text and `entity_types` its
    entity types. With no entity types their line is empty and is still
    there. A content longer than 2,000 is cut to its first 2,000, and three
    full stops follow it.
    """
    types = f"Key entity types: {_listed(entity_types)}" if entity_types else ""
    shown = f"{content[:_CONTENT]}..." if len(content) > _CONTENT else content
    text = (
        f'Create a brief, intelligent summary of this resource titled "{name}".\n'
        f"{types}\n"
        "\n"
        "Resource content:\n"
        f"{shown}\n"
        "\n"
        "Write a 2-3 sentence summary that captures the key points and would help someone understand what this resource contains."
    )
    return Prompt(text, max_tokens=150, temperature=0.5)


def reference_suggestions_prompt(*, title: str, entity_type: str | None = None, stub: str | None = None) -> Prompt:
    """The prompt that asks what to look at next for a reference.

    `title` is its title, `entity_type` one entity type and `stub` a short
    text already written for it. An entity type or a stub that is absent or
    empty is left out. A stub longer than 500 is cut to its first 500, and
    nothing follows it.
    """
    kind = f" (type: {entity_type})" if entity_type else ""
    stubbed = f' with current stub: "{stub[:_STUB]}"' if stub else ""
    text = (
        f'For a reference titled "{title}"{kind}{stubbed}, suggest 3 specific, actionable next steps or related topics to explore.\n'
        "\n"
        "Format as a simple list, one suggestion per line."
    )
    return Prompt(text, max_tokens=200, temperature=0.8)


def annotation_summary_prompt(*, resource: str, before: str, selected: str, after: str, entity_types: Sequence[str]) -> Prompt:
    """The prompt that asks for a summary of a passage where it stands.

    `resource` is the name of the resource, and `before`, `selected` and
    `after` its text before the passage, the passage, and its text after.
    The prompt has the last 200 of what is before and the first 200 of what
    is after. `entity_types` are the annotation's: with none, the last line
    ends with the space after its colon.
    """
    text = (
        "Summarize this text in context:\n"
        "\n"
        f'Context before: "{before_passage(before)}"\n'
        f'Selected exact: "{selected}"\n'
        f'Context after: "{after_passage(after)}"\n'
        "\n"
        f"Resource: {resource}\n"
        f"Entity types: {_listed(entity_types)}"
    )
    return Prompt(text, max_tokens=500, temperature=0.5)
