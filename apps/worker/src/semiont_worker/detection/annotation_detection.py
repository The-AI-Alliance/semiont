"""A detection of passages over a text: highlighting, commenting, assessing and tagging.

Each asks its model about the text a piece at a time, in its kind's prompt,
and reads each reply into the passages it proposes
(`semiont_worker.detection.parsers`). The pieces are the chunk plan's: the
budget is worked out from the provider's limits and the prompt around an
empty text, the walk cuts each piece once the one before is done, and a
piece whose reply fails in a way a smaller piece can fix is asked again in
smaller pieces. A passage is anchored in the whole text, whichever piece
proposed it, so its offsets are the text's. A passage two pieces both see is
handed on twice: whoever makes the annotations removes repeats.
"""

from collections.abc import Awaitable, Callable, Sequence

from pydantic import JsonValue
from semiont.annotations import TextSpan
from semiont.types import TagSchema, UnitCursor
from semiont_inference.interface import ElementSchema, InferenceClient

from semiont_worker.chunking import Chunking, estimate_tokens
from semiont_worker.detection.chunk_plan import (
    DETECTION_TEMPERATURE,
    AdaptiveChunk,
    ChunkCallResult,
    ChunkCursor,
    assert_not_truncated,
    call_chunk_subdividing,
    derive_detection_budget,
    run_adaptive_chunks,
)
from semiont_worker.detection.chunk_size import CallOutcome
from semiont_worker.detection.parsers import (
    ASSESSMENT_ELEMENT_SCHEMA,
    COMMENT_ELEMENT_SCHEMA,
    HIGHLIGHT_ELEMENT_SCHEMA,
    TAG_ELEMENT_SCHEMA,
    Anchored,
    AssessmentMatch,
    CommentMatch,
    TagMatch,
    read_assessments,
    read_comments,
    read_highlights,
    read_tags,
)
from semiont_worker.detection.prompts import assessment_prompt, comment_prompt, highlight_prompt, tag_prompt
from semiont_worker.inference_call import bounded_generate_structured
from semiont_worker.telemetry import DetectionLabel

type OnActivity = Callable[[int, int], None]
"""What is told where a detection stands: an offset into the text, and the text's length, both in code points.

It is told at each boundary between pieces, where the offset has moved on,
and every fifteen seconds while a piece is with the model, where it has not:
the offset is then where that piece began. The second says only that the job
is alive. Whoever follows a job takes silence for a job that died, and a
text of one piece crosses no boundary.
"""

type OnChunkResults[M] = Callable[[list[M], ChunkCursor, int], Awaitable[None]]
"""What is handed what one piece gave: what was read of it, where the walk stands once it is committed, and how many proposals were dropped.

It is called once for each piece, the last too, and awaited before the next
piece is cut: whoever is handed a piece commits it, and the walk does not
run ahead of what is durable. The cursor comes with what it is the cursor
of, so that a position cannot be recorded without it.
"""


async def _detect_in_pieces[M](
    client: InferenceClient,
    text: str,
    label: DetectionLabel,
    element_schema: ElementSchema,
    prompt: Callable[[str], str],
    read: Callable[[Sequence[JsonValue]], Anchored[M]],
    on_activity: OnActivity,
    resume: UnitCursor | None,
    on_chunk_results: OnChunkResults[M],
) -> None:
    """Ask about `text` a piece at a time, in `prompt` around each piece, and hand on what `read` makes of each piece's reply."""
    limits = await client.limits()
    # One kind of span to a call.
    budget = derive_detection_budget(limits, estimate_tokens(prompt("")), 1)
    output_budget = budget.bounds.output_budget

    async def on_chunk(chunk: AdaptiveChunk) -> CallOutcome:
        async def call(piece: str) -> ChunkCallResult:
            response = await bounded_generate_structured(
                client,
                prompt(piece),
                output_budget,
                DETECTION_TEMPERATURE,
                element_schema,
                # Still with the model, and where the piece began.
                lambda: on_activity(chunk.at, chunk.total_chars),
            )
            assert_not_truncated(response.stop_reason, f"{label} detection", chunk.at, chunk.total_chars, output_budget)
            return ChunkCallResult(items=response.items, usage=response.usage, counted=None)

        asked = await call_chunk_subdividing(
            label, chunk.piece, Chunking(chunk_size=chunk.size, overlap=budget.chunking.overlap), call, None, None
        )
        anchored = read(asked.items)
        await on_chunk_results(anchored.matches, ChunkCursor(next=chunk.next, size=chunk.size), anchored.dropped)
        # A boundary, where text remains. After the last piece there is none, and the unit's end is its caller's to say.
        if chunk.next < chunk.total_chars:
            on_activity(chunk.next, chunk.total_chars)
        return asked.outcome

    await run_adaptive_chunks(text, budget, on_chunk, resume)


async def detect_highlights(
    text: str,
    client: InferenceClient,
    *,
    instructions: str | None,
    density: float | None,
    source_language: str | None,
    on_activity: OnActivity,
    resume: UnitCursor | None,
    on_chunk_results: OnChunkResults[TextSpan],
) -> None:
    """Ask `client` for the passages of `text` worth a reader's attention. A highlight is the passage alone."""
    await _detect_in_pieces(
        client,
        text,
        "highlight",
        HIGHLIGHT_ELEMENT_SCHEMA,
        lambda piece: highlight_prompt(piece, instructions=instructions, density=density, source_language=source_language),
        lambda elements: read_highlights(elements, text),
        on_activity,
        resume,
        on_chunk_results,
    )


async def detect_comments(
    text: str,
    client: InferenceClient,
    *,
    instructions: str | None,
    tone: str | None,
    density: float | None,
    language: str | None,
    source_language: str | None,
    on_activity: OnActivity,
    resume: UnitCursor | None,
    on_chunk_results: OnChunkResults[CommentMatch],
) -> None:
    """Ask `client` for passages of `text`, each with a comment the model writes, in `language`."""
    await _detect_in_pieces(
        client,
        text,
        "comment",
        COMMENT_ELEMENT_SCHEMA,
        lambda piece: comment_prompt(
            piece, instructions=instructions, tone=tone, density=density, language=language, source_language=source_language
        ),
        lambda elements: read_comments(elements, text),
        on_activity,
        resume,
        on_chunk_results,
    )


async def detect_assessments(
    text: str,
    client: InferenceClient,
    *,
    instructions: str | None,
    tone: str | None,
    density: float | None,
    language: str | None,
    source_language: str | None,
    on_activity: OnActivity,
    resume: UnitCursor | None,
    on_chunk_results: OnChunkResults[AssessmentMatch],
) -> None:
    """Ask `client` for passages of `text`, each with an assessment the model writes, in `language`."""
    await _detect_in_pieces(
        client,
        text,
        "assessment",
        ASSESSMENT_ELEMENT_SCHEMA,
        lambda piece: assessment_prompt(
            piece, instructions=instructions, tone=tone, density=density, language=language, source_language=source_language
        ),
        lambda elements: read_assessments(elements, text),
        on_activity,
        resume,
        on_chunk_results,
    )


async def detect_tags(
    text: str,
    client: InferenceClient,
    *,
    schema: TagSchema,
    category: str,
    source_language: str | None,
    on_activity: OnActivity,
    resume: UnitCursor | None,
    on_chunk_results: OnChunkResults[TagMatch],
) -> None:
    """Ask `client` for the passages of `text` that serve as `category`, one category of `schema`.

    The schema is handed over with the job, so nothing is looked up. A tag's
    category is the schema's own word and not the model's, so no language is
    asked for.

    Raises `ValueError` for a category the schema does not have, before
    anything is asked of the model.
    """
    of_the_schema = next((tag for tag in schema.tags if tag.name == category), None)
    if of_the_schema is None:
        raise ValueError(f'Invalid category "{category}" for schema {schema.id}')
    await _detect_in_pieces(
        client,
        text,
        "tag",
        TAG_ELEMENT_SCHEMA,
        lambda piece: tag_prompt(piece, schema, of_the_schema, source_language=source_language),
        lambda elements: read_tags(elements, text, category),
        on_activity,
        resume,
        on_chunk_results,
    )
