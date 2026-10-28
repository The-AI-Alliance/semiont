"""What a Librarian reads from a model's structured reply: the scores and the suggestions two of its prompts ask for.

Both are asked for as an array of elements the provider holds to a schema
(`semiont_inference.interface.InferenceClient.generate_structured`), and
`docs/protocol/LIBRARIAN.md` § The model's score and § Gathering around a
resource state the two readings. `specs/src/librarian/reply-cases.json` is
the rule of what is read from the elements, and
`specs/src/librarian/prompt-cases.json` states the two schemas.

A provider holds a reply to the shape of a schema, and to nothing a schema
of this kind cannot say: that a number is whole, or from 0 to 1, or the
number of a candidate that was shown. So an element is read for what it has,
and one that is not what was asked for gives nothing and is no error.
"""

from collections.abc import Sequence
from typing import Final, final

from pydantic import JsonValue
from semiont_inference.interface import ElementSchema, InferenceClient
from semiont_service.white_space import trimmed

from semiont_librarian.prompts import Prompt

__all__ = ["SCORE_ELEMENT", "SUGGESTION_ELEMENT", "ReplyCutOff", "ask_for_elements", "read_scores", "read_suggestions"]

SCORE_ELEMENT: Final[ElementSchema] = {
    "type": "object",
    "properties": {"candidate": {"type": "number"}, "score": {"type": "number"}},
    "required": ["candidate", "score"],
    "additionalProperties": False,
}
"""One element of a reply to a score prompt: a candidate's number in the prompt, and its score."""

SUGGESTION_ELEMENT: Final[ElementSchema] = {
    "type": "object",
    "properties": {"suggestion": {"type": "string"}},
    "required": ["suggestion"],
    "additionalProperties": False,
}
"""One element of a reply to a reference-suggestions prompt: one suggestion."""

_SUGGESTIONS: Final = 3
"""The most suggestions read from a reply."""


@final
class ReplyCutOff(Exception):
    """A model stopped at its token limit before its array was whole. What it had written is lost, and is not read as fewer elements."""


async def ask_for_elements(model: InferenceClient, prompt: Prompt, element: ElementSchema) -> list[JsonValue]:
    """The elements a model answers a prompt with, each held by its provider to `element`.

    The prompt is sent with its own token limit and temperature. Raises
    `ReplyCutOff` for a reply that stopped at the token limit, and whatever
    the model's client raises: a reply that is no array, and a model not
    known to hold a reply to a schema, among them.
    """
    reply = await model.generate_structured(prompt.text, prompt.max_tokens, prompt.temperature, element)
    if reply.stop_reason == "max_tokens":
        raise ReplyCutOff(f"the model stopped at its limit of {prompt.max_tokens} tokens before its reply was whole")
    return [*reply.items]


def _whole(number: JsonValue) -> int | None:
    """A number that is whole, as the whole number it is. `None` for one that is not, and for what is no number."""
    if isinstance(number, bool) or not isinstance(number, int | float):
        return None
    return int(number) if float(number).is_integer() else None


def read_scores(elements: Sequence[JsonValue], candidates: int) -> dict[int, float]:
    """The score a reply to a score prompt gives each candidate, by the candidate's number in the prompt, which counts from 1.

    `candidates` is how many the prompt listed. An element gives a score
    when its `candidate` is the number of one of them, a whole number, and
    its `score` is a number from 0 to 1, both ends included. Where two
    elements score one candidate, the later is read. A candidate no element
    scores is not in the answer.
    """
    scores: dict[int, float] = {}
    for element in elements:
        if not isinstance(element, dict):
            continue
        number, score = _whole(element.get("candidate")), element.get("score")
        if number is None or isinstance(score, bool) or not isinstance(score, int | float):
            continue
        if 1 <= number <= candidates and 0 <= score <= 1:
            scores[number] = float(score)
    return scores


def read_suggestions(elements: Sequence[JsonValue]) -> list[str] | None:
    """The suggestions a reply to a reference-suggestions prompt gives: its first three that have anything in them.

    Each is read without the white space at its two ends, and one with
    nothing left is dropped. `None` where none is left: a reply with no
    element among them.
    """
    said: list[str] = []
    for element in elements:
        suggestion = element.get("suggestion") if isinstance(element, dict) else None
        if isinstance(suggestion, str) and trimmed(suggestion):
            said.append(trimmed(suggestion))
    return said[:_SUGGESTIONS] or None
