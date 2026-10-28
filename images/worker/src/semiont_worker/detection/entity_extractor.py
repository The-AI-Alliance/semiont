"""A detection of the mentions of entity types over a text, and the count each reply's yield is checked against.

A linking job asks its model for every mention of an entity type, a piece at
a time, as the detections of passages do
(`semiont_worker.detection.annotation_detection`). What it hands on is each
mention as the model wrote it, not yet anchored: where the text has it is
settled by whoever makes the annotations.

A reply can read cleanly and still carry a fraction of the mentions its
piece holds, and nothing in the reply says so. So of a provider that asks
for it, each reply that was read is followed by a second, small call that
asks how many mentions the same piece holds. A reply that found under half
of that count is taken to have missed mentions, which only a smaller piece
can mend. `specs/src/worker/parser-cases.json` holds the reading and the
count.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Final, final

from pydantic import JsonValue
from semiont.annotations import QuotedText
from semiont.types import UnitCursor
from semiont.watched import Watched
from semiont_inference.interface import ElementSchema, InferenceClient, StructuredResponse

from semiont_worker.chunking import estimate_tokens
from semiont_worker.detection.annotation_detection import OnActivity, OnChunkResults
from semiont_worker.detection.chunk_plan import (
    DETECTION_TEMPERATURE,
    YIELD_COLLAPSE_BAND,
    AdaptiveChunk,
    ChunkCallResult,
    ChunkCursor,
    UnderReportedPiece,
    YieldCollapseError,
    assert_not_truncated,
    call_chunk_subdividing,
    derive_detection_budget,
    run_adaptive_chunks,
)
from semiont_worker.detection.chunk_size import CallOutcome
from semiont_worker.detection.parsers import quoted_of
from semiont_worker.detection.prompts import asked_for, count_prompt, mention_prompt
from semiont_worker.inference_call import bounded_generate_structured
from semiont_worker.log import LOG

ENTITY_ELEMENT_SCHEMA: Final[ElementSchema] = {
    "type": "object",
    "properties": {
        "exact": {"type": "string"},
        "entityType": {"type": "string"},
        "prefix": {"type": "string"},
        "suffix": {"type": "string"},
    },
    "required": ["exact", "entityType"],
    "additionalProperties": False,
}
"""One element of a linking reply: a mention, and the entity type it is of.

`prefix` and `suffix` are not required of it. Required, a model writes an
empty one where it would have left the member out.
"""


@final
@dataclass(frozen=True, slots=True)
class Mention:
    """A mention of an entity type, as the model wrote it: the words it quoted, with what it said stands beside them, and the type.

    It is not anchored. Whether the text holds the words, and where, is for
    `semiont.annotations.reconcile` to say of `quoted`.
    """

    quoted: QuotedText
    entity_type: str


COUNT_ELEMENT_SCHEMA: Final[ElementSchema] = {
    "type": "object",
    "properties": {"count": {"type": "integer"}},
    "required": ["count"],
    "additionalProperties": False,
}
"""The one element of a count's reply: how many mentions the piece holds.

Asked for as structure, as the extraction is, so that a model cannot answer
it in words. Asked for in words, a model began about a quarter of its answers
with a sentence, and ran out of its tokens before the number. It states no
`minimum`: the drivers rewrite no such keyword, and refuse a schema that has
one. A count below none is refused where the reply is read.
"""

COUNT_MAX_TOKENS: Final = 32
"""The most a count may answer: one element of one number, with the white space a model may lay it out in."""


def _count_of(response: StructuredResponse) -> int | None:
    """The count a reply states: the `count` of its one element, a whole number of 0 or more. `None` for any other reply.

    A reply cut off is no count, though it reads as a whole array: an array cut
    off part-way is still an array. A reply of no element, or of more than one,
    does not say which is the count. A schema that is only advice to its model
    can be answered otherwise, and `true` is an `int` in Python and no number.
    """
    if response.stop_reason == "max_tokens" or len(response.items) != 1:
        return None
    element = response.items[0]
    count = element.get("count") if isinstance(element, dict) else None
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return None
    return count


async def _counted(
    client: InferenceClient, piece: str, items: Sequence[JsonValue], entity_types: Sequence[str], on_unchecked: Callable[[], None]
) -> int | None:
    """Ask how many mentions `piece` holds, and hold what a reply found of it to that count.

    The count is asked of the same text and of the same types, so it needs
    nothing known of the text beforehand. Answers the count, where the reply
    found half of it or more. Raises a `YieldCollapseError` where it found
    less: the reply is taken to have missed mentions, and what it did find
    rides on the failure.

    A count that fails, or answers no count, checks nothing, and nothing is
    answered: what was read stands, and `on_unchecked` is told. The count is a
    check on a reading, and its own failure is not the reading's, but a reading
    left unchecked is said.
    """
    piece_chars = len(piece)
    try:
        response = await bounded_generate_structured(
            client, count_prompt(piece, entity_types), COUNT_MAX_TOKENS, DETECTION_TEMPERATURE, COUNT_ELEMENT_SCHEMA, None
        )
    except Exception as failure:
        LOG.warning(
            "Count-verifier call failed — yield check skipped for this chunk", extra={"pieceChars": piece_chars, "error": str(failure)}
        )
        on_unchecked()
        return None
    counted = _count_of(response)
    if counted is None:
        LOG.warning(
            "Count-verifier answer carried no count — yield check skipped for this chunk",
            extra={"pieceChars": piece_chars, "stopReason": response.stop_reason, "elements": len(response.items)},
        )
        on_unchecked()
        return None
    if len(items) * YIELD_COLLAPSE_BAND < counted:
        raise YieldCollapseError(
            f"Extraction found {len(items)} entities where a count call reports ~{counted} mentions "
            f"(band \N{MULTIPLICATION SIGN}{YIELD_COLLAPSE_BAND}) on a chunk of {piece_chars} code points "
            "— silent yield collapse: deterministic — a same-size retry returns the identical under-report.",
            [*items],
            UnderReportedPiece(found=len(items), counted=counted, piece_chars=piece_chars),
        )
    return counted


async def extract_entities(
    text: str,
    entity_types: Sequence[str],
    client: InferenceClient,
    *,
    include_descriptive_references: bool,
    source_language: str | None,
    cancelled: Watched[bool],
    on_activity: OnActivity,
    on_under_report: Callable[[UnderReportedPiece], None],
    on_counted: Callable[[int], None],
    on_unchecked: Callable[[], None],
    resume: UnitCursor | None,
    on_chunk_results: OnChunkResults[Mention],
) -> None:
    """Ask `client` for the mentions of `entity_types` in `text`, a piece at a time, and hand on each piece's as the piece is done.

    One call asks for every type of `entity_types`. With
    `include_descriptive_references` a description that stands for an entity
    is asked for beside its name. A mention's type is not written in any
    language, so only the text's is said.

    `on_chunk_results` is handed a piece's mentions, where the walk stands
    once they are committed, and how many mentions were of a type that was
    not asked for: those are no items, and a job counts them. It is called
    once for each piece and awaited before the next is cut. `on_activity` is
    told where the extraction stands: at each boundary between pieces, and
    every fifteen seconds while a piece is with the model.

    Where the provider checks yield, `on_counted` is told the count of each
    piece that is accepted, `on_under_report` the verdict of each kept though
    its count said more was there, and `on_unchecked` once for each accepted
    without a check, its count having failed or answered no count. A count
    that fails never precedes asking again, so such a piece is always accepted.

    `cancelled` is whether a cancellation has named the job. Once it has, no
    piece is asked about after the one in hand, which is handed on like any
    other, and no boundary is told.
    """

    def prompt(piece: str) -> str:
        return mention_prompt(
            piece, entity_types, include_descriptive_references=include_descriptive_references, source_language=source_language
        )

    limits = await client.limits()
    # Whether a reply's yield is checked is the provider's to say, as how many calls it takes at once is.
    verify_yield = client.verify_detection_yield
    # One call asks for every type, and its reply repeats the spans of each: the budget is told how many.
    budget = derive_detection_budget(limits, estimate_tokens(prompt("")), len(entity_types))
    output_budget = budget.bounds.output_budget
    of_a_type_asked_for = frozenset(entity_types)

    LOG.debug(
        "Sending entity extraction request",
        extra={
            "entityTypes": asked_for(entity_types),
            "chars": len(text),
            # The size the walk opens at, and how far a piece's cost may move it. How many pieces there will be is not
            # known until the walk reaches the end of the text.
            "openingChunkSizeTokens": budget.chunking.chunk_size,
            "ceilingChunkSizeTokens": budget.bounds.ceiling,
            "outputBudget": output_budget,
        },
    )

    async def on_chunk(chunk: AdaptiveChunk) -> CallOutcome:
        async def call(piece: str) -> ChunkCallResult:
            response = await bounded_generate_structured(
                client,
                prompt(piece),
                output_budget,
                DETECTION_TEMPERATURE,
                ENTITY_ELEMENT_SCHEMA,
                # Still with the model, and where the piece began.
                lambda: on_activity(chunk.at, chunk.total_chars),
            )
            LOG.debug(
                "Got entity extraction response",
                extra={
                    "at": chunk.at,
                    "totalChars": chunk.total_chars,
                    "chunkSizeTokens": chunk.size,
                    "pieceChars": len(piece),
                    "items": len(response.items),
                },
            )
            # Before anything is made of it: a reply cut off mid-array still reads as an array.
            assert_not_truncated(response.stop_reason, "Entity extraction", chunk.at, chunk.total_chars, output_budget)
            # A reply that was read whole may still have missed mentions, and only the count can say so.
            counted = await _counted(client, piece, response.items, entity_types, on_unchecked) if verify_yield else None
            return ChunkCallResult(items=response.items, usage=response.usage, counted=counted)

        asked = await call_chunk_subdividing("reference", chunk.piece, budget.chunking.overlap, call, on_under_report, on_counted)

        mentions: list[Mention] = []
        dropped = 0
        for element in asked.items:
            quoted = quoted_of(element)
            entity_type = element.get("entityType") if isinstance(element, dict) else None
            if quoted is None or not isinstance(entity_type, str):
                LOG.debug("Dropped malformed LLM entity", extra={"entity": element})
                continue
            # A mention of a type nobody asked for is not one of the type that was: it makes no annotation, and it is
            # counted, where passing it on would give it out as the type asked for.
            if entity_type not in of_a_type_asked_for:
                LOG.warning(
                    "Mention dropped — not of an entity type that was asked for", extra={"text": quoted.exact, "entityType": entity_type}
                )
                dropped += 1
                continue
            mentions.append(Mention(quoted=quoted, entity_type=entity_type))
        await on_chunk_results(mentions, ChunkCursor(next=chunk.next, size=chunk.size), dropped)

        # A boundary, where text remains. After the last piece there is none, and the unit's end is its caller's to say.
        # A cancelled job has stopped with this piece, and no next one starts anywhere.
        if chunk.next < chunk.total_chars and not cancelled.value:
            on_activity(chunk.next, chunk.total_chars)
        return asked.outcome

    await run_adaptive_chunks(text, budget, cancelled, on_chunk, resume)
