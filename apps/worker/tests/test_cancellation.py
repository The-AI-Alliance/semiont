"""A job that is cancelled: where it stops, what it has done by then, and what it says and does not say.

`docs/protocol/WORKER-SERVICE.md` § Cancellation states it (Q1 to Q5). A
held job says whether a cancellation has named it (`HeldJob.cancelled`, the
SDK's), and everything here that stops for one is handed that and reads it:
the walk over a text's pieces before each cut, a detection before it says
where the next piece starts, and a processor wherever it would begin
something or say something.

Three layers, each held where it decides: the walk, a detection over the
real walk with a model that is stood in for, and a processor, first with its
detection stood in for and then through the real one.
"""

import asyncio
from collections.abc import Awaitable, Callable, Coroutine, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, final

import pytest
from aio import run, turns, under_way
from pydantic import JsonValue
from semiont.annotations import QuotedText, TextSpan
from semiont.types import (
    Annotation,
    AssessingJobParams,
    CommentingJobParams,
    GenerationJobParams,
    HighlightingJobParams,
    JobProgress,
    LinkingJobParams,
    MarkJobDone,
    TagCategory,
    TaggingJobParams,
    TagSchema,
    UnitCursor,
)
from semiont.watched import Variable, Watched
from semiont_inference.interface import ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredResponse
from standing_in import (
    AskedToGenerate,
    Handed,
    assessments_stood_in,
    comments_stood_in,
    compiler_stood_in,
    generation_stood_in,
    highlights_stood_in,
    mentions_stood_in,
    pieces,
    report,
    tags_stood_in,
    text_build,
)

from semiont_worker.chunking import Chunking, cut_chunk, estimate_tokens
from semiont_worker.detection.annotation_detection import (
    OnActivity,
    detect_assessments,
    detect_comments,
    detect_highlights,
    detect_tags,
)
from semiont_worker.detection.chunk_plan import AdaptiveChunk, ChunkCursor, DetectionBudget, derive_detection_budget, run_adaptive_chunks
from semiont_worker.detection.chunk_size import CallOutcome
from semiont_worker.detection.entity_extractor import Mention, extract_entities
from semiont_worker.detection.parsers import AssessmentMatch, CommentMatch, TagMatch
from semiont_worker.detection.prompts import assessment_prompt, comment_prompt, highlight_prompt, mention_prompt, tag_prompt
from semiont_worker.generation.resource_generation import GeneratedDocument
from semiont_worker.generation.typst import Compiled, NotCompiled
from semiont_worker.processors import (
    Cancelled,
    GeneratedArtifact,
    GeneratedText,
    UnitCheckpoint,
    process_assessment_job,
    process_comment_job,
    process_generation_job,
    process_highlight_job,
    process_reference_job,
    process_tag_job,
)

# A hundred and twenty sentences, each naming a marker no other names: a text of several pieces, in which a span says
# which piece proposed it.
TEXT: Final = " ".join(f"Sentence {n} of the survey names marker {n:03d} beside the river." for n in range(1, 121))
SHORT: Final = "alpha beta gamma delta"

CLAIM: Final = TagCategory(name="Claim", description="What the text asserts", examples=["What is being asserted?"])
EVIDENCE: Final = TagCategory(name="Evidence", description="What supports the assertion", examples=["What supports it?"])
SCHEMA: Final = TagSchema(id="argument", name="Argument", description="What a text claims", domain="rhetoric", tags=[CLAIM, EVIDENCE])

NOT_RESUMED: Final[Mapping[str, UnitCursor]] = {}
NONE_FINISHED: Final[Sequence[str]] = ()


def window(tokens: int) -> InferenceLimits:
    """A model with one window of `tokens` for prompt and reply."""
    return InferenceLimits(context_tokens=tokens, max_output_tokens=tokens, output_tokens_per_hour=None, accepts_temperature=None)


# ── the walk ────────────────────────────────────────────────────────────


def a_walk(
    text: str, budget: DetectionBudget, cancelled: Variable[bool], cancel_at: int | None, resume: UnitCursor | None
) -> list[AdaptiveChunk]:
    """Walk `text`, and answer the pieces it handed out. With `cancel_at`, the cancellation arrives while that piece is in hand."""
    seen: list[AdaptiveChunk] = []

    async def on_chunk(chunk: AdaptiveChunk) -> CallOutcome:
        seen.append(chunk)
        # A turn of the loop: the piece in hand is awaited to its end before the walk looks again.
        await asyncio.sleep(0)
        if len(seen) == cancel_at:
            cancelled.set(True)
        return CallOutcome(recovered=None, output_tokens=None)

    run(run_adaptive_chunks(text, budget, cancelled, on_chunk, resume))
    return seen


def test_the_walk_cuts_no_piece_once_its_job_is_cancelled_and_the_piece_in_hand_is_finished_first() -> None:
    # Q1 and Q4: a job stops between pieces, never inside one.
    budget = derive_detection_budget(window(1400), 500, 1)
    whole = a_walk(TEXT, budget, Variable[bool](False), None, None)
    assert len(whole) >= 4, "the text is one of several pieces"
    assert whole[-1].next == len(TEXT)

    stopped = a_walk(TEXT, budget, Variable[bool](False), 2, None)

    # The second piece was awaited to its end, and no third was cut though text remained.
    assert stopped == whole[:2]
    assert stopped[1].next < len(TEXT)


def test_the_walk_of_a_job_cancelled_before_it_begins_cuts_nothing_wherever_it_would_have_begun() -> None:
    budget = derive_detection_budget(window(1400), 500, 1)
    cancelled = Variable[bool](False)
    cancelled.set(True)

    assert a_walk(TEXT, budget, cancelled, None, None) == []
    assert a_walk(TEXT, budget, cancelled, None, UnitCursor(next=300, size=200, found=0, emitted=0, errors=0)) == []


# ── a detection: no piece after the one a cancellation arrived on, and no boundary said after it ──

type Kept = Callable[[Sequence[TextSpan | Mention], ChunkCursor, int], Awaitable[None]]
type Detect = Callable[[InferenceClient, Watched[bool], OnActivity, Kept], Coroutine[None, None, None]]


async def highlights(client: InferenceClient, cancelled: Watched[bool], on_activity: OnActivity, kept: Kept) -> None:
    await detect_highlights(
        TEXT,
        client,
        instructions=None,
        density=None,
        source_language=None,
        cancelled=cancelled,
        on_activity=on_activity,
        resume=None,
        on_chunk_results=kept,
    )


async def comments(client: InferenceClient, cancelled: Watched[bool], on_activity: OnActivity, kept: Kept) -> None:
    await detect_comments(
        TEXT,
        client,
        instructions=None,
        tone=None,
        density=None,
        language=None,
        source_language=None,
        cancelled=cancelled,
        on_activity=on_activity,
        resume=None,
        on_chunk_results=kept,
    )


async def assessments(client: InferenceClient, cancelled: Watched[bool], on_activity: OnActivity, kept: Kept) -> None:
    await detect_assessments(
        TEXT,
        client,
        instructions=None,
        tone=None,
        density=None,
        language=None,
        source_language=None,
        cancelled=cancelled,
        on_activity=on_activity,
        resume=None,
        on_chunk_results=kept,
    )


async def tags(client: InferenceClient, cancelled: Watched[bool], on_activity: OnActivity, kept: Kept) -> None:
    await detect_tags(
        TEXT,
        client,
        schema=SCHEMA,
        category="Claim",
        source_language=None,
        cancelled=cancelled,
        on_activity=on_activity,
        resume=None,
        on_chunk_results=kept,
    )


def untold(_told: object) -> None:
    """A count, or a verdict, told to nobody."""


async def mentions(client: InferenceClient, cancelled: Watched[bool], on_activity: OnActivity, kept: Kept) -> None:
    await extract_entities(
        TEXT,
        ["Person"],
        client,
        include_descriptive_references=False,
        source_language=None,
        cancelled=cancelled,
        on_activity=on_activity,
        on_under_report=untold,
        on_counted=untold,
        on_unchecked=lambda: None,
        resume=None,
        on_chunk_results=kept,
    )


@final
@dataclass(frozen=True, slots=True)
class Kind:
    """One kind of detection, as a job that states nothing but what it must asks for it."""

    name: str
    scaffold: str
    """The kind's prompt around an empty text."""
    detect: Detect


KINDS: Final = [
    Kind("highlighting", highlight_prompt("", instructions=None, density=None, source_language=None), highlights),
    Kind("commenting", comment_prompt("", instructions=None, tone=None, density=None, language=None, source_language=None), comments),
    Kind("assessing", assessment_prompt("", instructions=None, tone=None, density=None, language=None, source_language=None), assessments),
    Kind("tagging", tag_prompt("", SCHEMA, CLAIM, source_language=None), tags),
    Kind("linking", mention_prompt("", ["Person"], include_descriptive_references=False, source_language=None), mentions),
]
EVERY_KIND: Final = pytest.mark.parametrize("kind", KINDS, ids=[kind.name for kind in KINDS])


def limits_of(kind: Kind) -> InferenceLimits:
    """A model whose one window leaves 600 tokens beside the kind's prompt: a third of it is a piece, and `TEXT` is several."""
    return window(estimate_tokens(kind.scaffold) + 600)


def first_cut(kind: Kind) -> tuple[int, int]:
    """Where the second piece of `TEXT` starts for a unit of this kind, and the size its first was cut at."""
    budget = derive_detection_budget(limits_of(kind), estimate_tokens(kind.scaffold), 1)
    size = budget.chunking.chunk_size
    return cut_chunk(TEXT, 0, Chunking(chunk_size=size, overlap=budget.chunking.overlap)).next, size


@final
class Model:
    """A provider that is stood in for: it answers each call for items from a list, each count from another, and can hold an answer.

    It verifies yield when it is given counts. The call for items it holds,
    where it holds one, is answered once the test lets it go: until then the
    call is awaited, as one a real model has not yet answered is.
    """

    def __init__(
        self, limits: InferenceLimits, items: Sequence[Sequence[JsonValue]], counts: Sequence[str] | None, hold: int | None
    ) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = "stand-in"
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = counts is not None
        self.asked: list[str] = []
        """The prompt of each call for items, as made."""
        self.counted: list[str] = []
        """The prompt of each count, as made."""
        self.holding: Final = asyncio.Event()
        self.let_go: Final = asyncio.Event()
        self.abandoned = False
        """Whether the held call was ended before it was answered."""
        self._limits: Final = limits
        self._items: Final = items
        self._counts: Final = counts
        self._hold: Final = hold

    async def limits(self) -> InferenceLimits:
        return self._limits

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        assert self._counts is not None, "a provider that does not verify yield is asked for no count"
        self.counted.append(prompt)
        return InferenceResponse(text=self._counts[min(len(self.counted), len(self._counts)) - 1], stop_reason="end_turn", usage=None)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        self.asked.append(prompt)
        nth = len(self.asked)
        if nth == self._hold:
            self.holding.set()
            try:
                await self.let_go.wait()
            except asyncio.CancelledError:
                self.abandoned = True
                raise
        else:
            await asyncio.sleep(0)
        return StructuredResponse(items=[*self._items[min(nth, len(self._items)) - 1]], stop_reason="end_turn", usage=None)


@EVERY_KIND
def test_a_detection_asks_about_no_piece_after_the_one_a_cancellation_arrived_on_and_says_no_boundary_after_it(kind: Kind) -> None:
    client = Model(limits_of(kind), [[]], None, None)
    cancelled = Variable[bool](False)
    stood: list[tuple[int, int]] = []
    handed_on: list[ChunkCursor] = []

    async def kept(_items: Sequence[TextSpan | Mention], cursor: ChunkCursor, _dropped: int) -> None:
        handed_on.append(cursor)
        # The cancellation arrives while the first piece's items are being committed.
        await asyncio.sleep(0)
        cancelled.set(True)

    run(kind.detect(client, cancelled, lambda consumed, total: stood.append((consumed, total)), kept))

    # The piece in hand was handed over. The model was not asked about the next, though text remained.
    next_, size = first_cut(kind)
    assert (len(client.asked), handed_on) == (1, [ChunkCursor(next=next_, size=size)])
    assert next_ < len(TEXT)
    # Q5: where the next piece would start is not said. The job has stopped.
    assert stood == []


@EVERY_KIND
def test_a_detection_whose_job_is_not_cancelled_says_each_boundary_and_asks_about_every_piece(kind: Kind) -> None:
    client = Model(limits_of(kind), [[]], None, None)
    stood: list[tuple[int, int]] = []
    handed_on: list[ChunkCursor] = []

    async def kept(_items: Sequence[TextSpan | Mention], cursor: ChunkCursor, _dropped: int) -> None:
        handed_on.append(cursor)

    run(kind.detect(client, Variable[bool](False), lambda consumed, total: stood.append((consumed, total)), kept))

    assert len(client.asked) == len(handed_on) >= 4
    assert stood == [(cursor.next, len(TEXT)) for cursor in handed_on[:-1]]
    assert handed_on[-1].next == len(TEXT)


@EVERY_KIND
def test_a_cancellation_does_not_end_a_generation_that_is_under_way_the_piece_is_handed_on_when_it_is_answered(kind: Kind) -> None:
    # Q4: the request to the provider is not ended, and the job stops at the next stopping place.
    async def scenario() -> None:
        client = Model(limits_of(kind), [[]], None, 1)
        cancelled = Variable[bool](False)
        handed_on: list[ChunkCursor] = []

        async def kept(_items: Sequence[TextSpan | Mention], cursor: ChunkCursor, _dropped: int) -> None:
            handed_on.append(cursor)

        detecting = await under_way(kind.detect(client, cancelled, lambda _consumed, _total: None, kept))
        assert client.holding.is_set()
        cancelled.set(True)
        await turns()
        # The cancellation did not end the request: the detection still waits on it, and has handed nothing on.
        assert (detecting.done(), client.abandoned, handed_on) == (False, False, [])
        client.let_go.set()
        await detecting
        assert (len(client.asked), len(handed_on), client.abandoned) == (1, 1, False)

    run(scenario())


# ── a processor, its detection stood in for ─────────────────────────────

HIGHLIGHTING: Final = HighlightingJobParams(motivation="highlighting")
COMMENTING: Final = CommentingJobParams(motivation="commenting")
ASSESSING: Final = AssessingJobParams(motivation="assessing")
END: Final = len(SHORT)

type Runs = Callable[[pytest.MonkeyPatch, str, Handed, int | None], tuple[MarkJobDone | Cancelled, int]]
"""Run a job over a text with its detection stood in for, handing on one piece of nothing that ends at the offset given, or none at all.

Answers what the processor answered, and how many times its detection was asked.
"""


def cancelling_as_it_commits(handed: Handed) -> None:
    """From now on a cancellation arrives while a piece is being committed."""

    async def sink(annotations: list[Annotation], checkpoint: UnitCheckpoint) -> None:
        await handed.committed(annotations, checkpoint)
        handed.cancelled.set(True)

    handed.sink = sink


def run_highlighting(
    monkeypatch: pytest.MonkeyPatch, text: str, handed: Handed, ends_at: int | None
) -> tuple[MarkJobDone | Cancelled, int]:
    script = pieces(*([] if ends_at is None else [(list[TextSpan](), ChunkCursor(next=ends_at, size=5), 0)]))
    asked = highlights_stood_in(monkeypatch, script)
    answered = run(
        process_highlight_job(
            text,
            handed.client,
            HIGHLIGHTING,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
        )
    )
    return answered, len(asked)


def run_commenting(monkeypatch: pytest.MonkeyPatch, text: str, handed: Handed, ends_at: int | None) -> tuple[MarkJobDone | Cancelled, int]:
    script = pieces(*([] if ends_at is None else [(list[CommentMatch](), ChunkCursor(next=ends_at, size=5), 0)]))
    asked = comments_stood_in(monkeypatch, script)
    answered = run(
        process_comment_job(
            text,
            handed.client,
            COMMENTING,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
        )
    )
    return answered, len(asked)


def run_assessing(monkeypatch: pytest.MonkeyPatch, text: str, handed: Handed, ends_at: int | None) -> tuple[MarkJobDone | Cancelled, int]:
    script = pieces(*([] if ends_at is None else [(list[AssessmentMatch](), ChunkCursor(next=ends_at, size=5), 0)]))
    asked = assessments_stood_in(monkeypatch, script)
    answered = run(
        process_assessment_job(
            text,
            handed.client,
            ASSESSING,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
        )
    )
    return answered, len(asked)


def run_tagging(monkeypatch: pytest.MonkeyPatch, text: str, handed: Handed, ends_at: int | None) -> tuple[MarkJobDone | Cancelled, int]:
    script = pieces(*([] if ends_at is None else [(list[TagMatch](), ChunkCursor(next=ends_at, size=5), 0)]))
    asked = tags_stood_in(monkeypatch, script)
    answered = run(
        process_tag_job(
            text,
            handed.client,
            TaggingJobParams(motivation="tagging", schema_id=SCHEMA.id, categories=["Claim", "Evidence"]),
            SCHEMA,
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
        )
    )
    return answered, len(asked)


def run_linking(monkeypatch: pytest.MonkeyPatch, text: str, handed: Handed, ends_at: int | None) -> tuple[MarkJobDone | Cancelled, int]:
    found = [Mention(quoted=QuotedText(exact="alpha"), entity_type="Person")]
    script = pieces(*([] if ends_at is None else [(found, ChunkCursor(next=ends_at, size=5), 0)]))
    asked = mentions_stood_in(monkeypatch, script)
    answered = run(
        process_reference_job(
            text,
            handed.client,
            LinkingJobParams(motivation="linking", entity_types=["Person", "Place"]),
            build_annotation=text_build(text),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_unit_complete=handed.unit_complete,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
            completed_units=NONE_FINISHED,
        )
    )
    return answered, len(asked)


ONE_UNIT: Final = [("highlighting", run_highlighting), ("commenting", run_commenting), ("assessing", run_assessing)]
EVERY_JOB: Final = [*ONE_UNIT, ("tagging", run_tagging), ("linking", run_linking)]


@pytest.mark.parametrize(("unit", "job"), ONE_UNIT, ids=[unit for unit, _ in ONE_UNIT])
def test_a_job_of_one_unit_stopped_partway_names_no_unit_and_reports_no_end(monkeypatch: pytest.MonkeyPatch, unit: str, job: Runs) -> None:
    # Q1, Q2 and Q5.
    handed = Handed(1)
    cancelling_as_it_commits(handed)

    answered, _ = job(monkeypatch, SHORT, handed, 10)

    assert answered == Cancelled(completed_units=[])
    # The piece it was on was handed over to be committed, with where that left its unit.
    assert handed.committed.checkpoints == [UnitCheckpoint(unit=unit, cursor=UnitCursor(next=10, size=5, found=0, emitted=0, errors=0))]
    assert handed.told.codes() == ["loading", "analyzing", "creating-annotations"]


@pytest.mark.parametrize(("unit", "job"), ONE_UNIT, ids=[unit for unit, _ in ONE_UNIT])
def test_a_job_of_one_unit_stopped_on_its_last_piece_names_its_unit_and_still_reports_no_end(
    monkeypatch: pytest.MonkeyPatch, unit: str, job: Runs
) -> None:
    # Q2: a job with nothing left to do but settle is settled as cancelled all the same, every unit named.
    handed = Handed(1)
    cancelling_as_it_commits(handed)

    answered, _ = job(monkeypatch, SHORT, handed, END)

    assert answered == Cancelled(completed_units=[unit])
    assert handed.told.codes() == ["loading", "analyzing", "creating-annotations"]


@pytest.mark.parametrize(("unit", "job"), EVERY_JOB, ids=[unit for unit, _ in EVERY_JOB])
def test_a_job_cancelled_before_it_began_asks_nothing_and_reports_nothing(monkeypatch: pytest.MonkeyPatch, unit: str, job: Runs) -> None:
    # Q1: a job that is on no piece when the cancellation arrives asks about none.
    handed = Handed(1)
    handed.cancelled.set(True)

    answered, asked = job(monkeypatch, SHORT, handed, END)

    assert (answered, asked) == (Cancelled(completed_units=[]), 0)
    assert (handed.told.reports, handed.committed.batches, handed.finished) == ([], [], [])


def test_a_tagging_job_stopped_as_a_category_ends_names_that_category_and_never_begins_the_next(monkeypatch: pytest.MonkeyPatch) -> None:
    handed = Handed(1)
    cancelling_as_it_commits(handed)

    answered, asked = run_tagging(monkeypatch, SHORT, handed, END)

    assert (answered, asked) == (Cancelled(completed_units=["Claim"]), 1)
    # Nothing is said of the second category, and no end.
    assert handed.told.said() == [
        report(10, {"code": "loading"}, {}),
        report(30, {"code": "analyzing-tags"}, {}),
        report(
            30,
            {"code": "analyzing-tags"},
            {"current": {"kind": "category", "value": "Claim"}, "processed": 0, "total": 2, "completedItems": []},
        ),
        report(60, {"code": "creating-tag-annotations", "count": 0}, {}),
    ]


def test_a_tagging_job_stopped_partway_through_a_category_names_none_and_never_begins_the_next(monkeypatch: pytest.MonkeyPatch) -> None:
    handed = Handed(1)
    cancelling_as_it_commits(handed)

    answered, asked = run_tagging(monkeypatch, SHORT, handed, 10)

    assert (answered, asked) == (Cancelled(completed_units=[]), 1)


def test_a_linking_job_stopped_partway_through_an_entity_type_neither_finishes_nor_names_it_and_begins_no_other(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handed = Handed(1)
    said_by_the_commit = -1

    async def sink(annotations: list[Annotation], checkpoint: UnitCheckpoint) -> None:
        nonlocal said_by_the_commit
        await handed.committed(annotations, checkpoint)
        # The cancellation arrives while the piece is being committed.
        said_by_the_commit = len(handed.told.reports)
        handed.cancelled.set(True)

    handed.sink = sink

    answered, asked = run_linking(monkeypatch, SHORT, handed, 10)

    assert (answered, asked, handed.finished) == (Cancelled(completed_units=[]), 1, [])
    assert handed.committed.checkpoints == [UnitCheckpoint(unit="Person", cursor=UnitCursor(next=10, size=5, found=1, emitted=1, errors=0))]
    # Q5: nothing is reported after the piece's commit: not that its batch is established, and no end.
    assert len(handed.told.reports) == said_by_the_commit
    assert handed.told.codes() == ["loading", "detecting-entities"]


def test_a_linking_job_stopped_on_the_last_piece_of_an_entity_type_finishes_and_names_it_and_begins_no_other(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # D14 and Q1: the piece was the type's last, so the type is finished as any other is.
    handed = Handed(1)
    cancelling_as_it_commits(handed)

    answered, asked = run_linking(monkeypatch, SHORT, handed, END)

    assert (answered, asked, handed.finished) == (Cancelled(completed_units=["Person"]), 1, ["Person"])
    assert handed.told.codes() == ["loading", "detecting-entities"]


def test_a_linking_job_names_on_its_cancel_what_this_attempt_finished_and_not_what_the_record_already_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Q2.
    found = [Mention(quoted=QuotedText(exact="alpha"), entity_type="Place")]
    asked = mentions_stood_in(monkeypatch, pieces((found, ChunkCursor(next=END, size=5), 0)))
    handed = Handed(1)
    cancelling_as_it_commits(handed)

    answered = run(
        process_reference_job(
            SHORT,
            handed.client,
            LinkingJobParams(motivation="linking", entity_types=["Person", "Place"]),
            build_annotation=text_build(SHORT),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_unit_complete=handed.unit_complete,
            on_chunk_complete=handed.sink,
            resume_cursors={"Person": UnitCursor(next=END, size=5, found=2, emitted=2, errors=0)},
            completed_units=["Person"],
        )
    )

    assert answered == Cancelled(completed_units=["Place"])
    assert [call.entity_types for call in asked] == [["Place"]]


# ── a processor, through the real detection ─────────────────────────────


def marker(number: int) -> JsonValue:
    return {"exact": f"marker {number:03d}"}


async def held_then_cancelled[T](client: Model, handed: Handed, job: Awaitable[T]) -> T:
    """Run `job` as far as its first call to the model, have the cancellation arrive while that call is held, and let the model answer."""
    working = await under_way(job)
    assert client.holding.is_set()
    handed.cancelled.set(True)
    await turns()
    # The cancellation did not end the request: the job still waits on it, and has said nothing of it since.
    assert (working.done(), client.abandoned) == (False, False)
    client.let_go.set()
    return await working


def test_a_highlighting_job_cancelled_while_its_first_piece_is_with_the_model_commits_that_piece_and_stops() -> None:
    # Q1, Q4 and Q5, as `worker-service/cancel` holds them.
    kind = KINDS[0]
    next_, size = first_cut(kind)

    async def scenario() -> tuple[MarkJobDone | Cancelled, Model, Handed]:
        client = Model(limits_of(kind), [[marker(1), marker(2)]], None, 1)
        handed = Handed(1)
        answered = await held_then_cancelled(
            client,
            handed,
            process_highlight_job(
                TEXT,
                client,
                HIGHLIGHTING,
                build_annotation=text_build(TEXT),
                on_progress=handed.told,
                cancelled=handed.cancelled,
                on_chunk_complete=handed.sink,
                resume_cursors=NOT_RESUMED,
            ),
        )
        return answered, client, handed

    answered, client, handed = run(scenario())

    # One generation: the second piece was never asked about.
    assert len(client.asked) == 1
    assert [len(batch) for batch in handed.committed.batches] == [2]
    assert handed.committed.checkpoints == [
        UnitCheckpoint(unit="highlighting", cursor=UnitCursor(next=next_, size=size, found=2, emitted=2, errors=0))
    ]
    # It was partway through its one unit: none is named.
    assert next_ < len(TEXT)
    assert answered == Cancelled(completed_units=[])
    # What the piece made is reported. Where the next piece would start, and an end, are not.
    assert handed.told.said() == [
        report(10, {"code": "loading"}, {}),
        report(30, {"code": "analyzing"}, {}),
        report(60, {"code": "creating-annotations", "count": 2}, {}),
    ]


def test_a_highlighting_job_that_is_not_cancelled_says_where_it_stands_after_each_piece_but_the_last() -> None:
    # D17: after each piece, the count, and, when text remains, analyzing at 30 + round(30 x next / length).
    kind = KINDS[0]
    client = Model(limits_of(kind), [[]], None, None)
    handed = Handed(1)

    answered = run(
        process_highlight_job(
            TEXT,
            client,
            HIGHLIGHTING,
            build_annotation=text_build(TEXT),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
        )
    )

    assert isinstance(answered, MarkJobDone)
    cursors = [checkpoint.cursor for checkpoint in handed.committed.checkpoints]
    assert len(cursors) == len(client.asked) >= 4
    between: list[JsonValue] = []
    for cursor in cursors[:-1]:
        between.append(report(60, {"code": "creating-annotations", "count": 0}, {}))
        # Thirty times `next` over the length, to the nearest whole number, in whole-number arithmetic.
        between.append(report(30 + (60 * cursor.next + len(TEXT)) // (2 * len(TEXT)), {"code": "analyzing"}, {}))
    assert handed.told.said() == [
        report(10, {"code": "loading"}, {}),
        report(30, {"code": "analyzing"}, {}),
        *between,
        report(60, {"code": "creating-annotations", "count": 0}, {}),
        report(100, {"code": "complete-created", "count": 0, "motivation": "highlighting"}, {}),
    ]


def test_a_tagging_job_cancelled_while_its_first_category_is_with_the_model_finishes_that_category_and_asks_about_no_other() -> None:
    # The short text is one piece for each category.
    limits = window(estimate_tokens(tag_prompt("", SCHEMA, EVIDENCE, source_language=None)) + 600)

    async def scenario() -> tuple[MarkJobDone | Cancelled, Model, Handed]:
        client = Model(limits, [[{"exact": "gamma"}]], None, 1)
        handed = Handed(1)
        answered = await held_then_cancelled(
            client,
            handed,
            process_tag_job(
                SHORT,
                client,
                TaggingJobParams(motivation="tagging", schema_id=SCHEMA.id, categories=["Claim", "Evidence"]),
                SCHEMA,
                build_annotation=text_build(SHORT),
                on_progress=handed.told,
                cancelled=handed.cancelled,
                on_chunk_complete=handed.sink,
                resume_cursors=NOT_RESUMED,
            ),
        )
        return answered, client, handed

    answered, client, handed = run(scenario())

    assert client.asked == [tag_prompt(SHORT, SCHEMA, CLAIM, source_language=None)]
    assert [(checkpoint.unit, checkpoint.cursor.next, checkpoint.cursor.emitted) for checkpoint in handed.committed.checkpoints] == [
        ("Claim", END, 1)
    ]
    # The category it finished is named. The one it never began is not.
    assert answered == Cancelled(completed_units=["Claim"])
    assert handed.told.said() == [
        report(10, {"code": "loading"}, {}),
        report(30, {"code": "analyzing-tags"}, {}),
        report(
            30,
            {"code": "analyzing-tags"},
            {"current": {"kind": "category", "value": "Claim"}, "processed": 0, "total": 2, "completedItems": []},
        ),
        report(60, {"code": "creating-tag-annotations", "count": 1}, {}),
    ]


def test_a_linking_job_cancelled_while_a_piece_s_extraction_is_with_the_model_counts_and_commits_that_piece_and_stops() -> None:
    kind = KINDS[4]
    next_, size = first_cut(kind)

    async def scenario() -> tuple[MarkJobDone | Cancelled, Model, Handed]:
        client = Model(limits_of(kind), [[{"exact": "marker 003", "entityType": "Person"}]], ["1"], 1)
        handed = Handed(1)
        answered = await held_then_cancelled(
            client,
            handed,
            process_reference_job(
                TEXT,
                client,
                LinkingJobParams(motivation="linking", entity_types=["Person", "Place"]),
                build_annotation=text_build(TEXT),
                on_progress=handed.told,
                cancelled=handed.cancelled,
                on_unit_complete=handed.unit_complete,
                on_chunk_complete=handed.sink,
                resume_cursors=NOT_RESUMED,
                completed_units=NONE_FINISHED,
            ),
        )
        return answered, client, handed

    answered, client, handed = run(scenario())

    # The piece's two generations, its extraction and its count, and no more: not the type's next piece, and not the next type.
    assert (len(client.asked), len(client.counted)) == (1, 1)
    # The type is partway: its cursor is said, and it is not among the finished.
    assert handed.committed.checkpoints == [
        UnitCheckpoint(unit="Person", cursor=UnitCursor(next=next_, size=size, found=1, emitted=1, errors=0))
    ]
    assert next_ < len(TEXT)
    assert (answered, handed.finished) == (Cancelled(completed_units=[]), [])

    request_params: JsonValue = [{"label": "entity-types", "value": "Person, Place"}]

    def standing(expected: int | None) -> JsonValue:
        return report(
            20,
            {"code": "detecting-entities", "entityType": "Person"},
            {
                "current": {"kind": "entity-type", "value": "Person"},
                "processed": 0,
                "total": 2,
                "entitiesFound": 0,
                **({} if expected is None else {"entitiesExpected": expected}),
                "entitiesEmitted": 0,
                "completedItems": [],
                "requestParams": request_params,
            },
        )

    # The type begun, and its mentions counted: both said while the piece was being asked about. Nothing after its checkpoint.
    assert handed.told.said() == [report(10, {"code": "loading"}, {"requestParams": request_params}), standing(None), standing(1)]


def test_a_linking_job_cancelled_on_the_last_piece_of_its_last_entity_type_is_cancelled_all_the_same_with_the_type_named() -> None:
    limits = window(estimate_tokens(mention_prompt("", ["Person"], include_descriptive_references=False, source_language=None)) + 600)

    async def scenario() -> tuple[MarkJobDone | Cancelled, Model, Handed]:
        client = Model(limits, [[{"exact": "alpha", "entityType": "Person"}]], ["1"], 1)
        handed = Handed(1)
        answered = await held_then_cancelled(
            client,
            handed,
            process_reference_job(
                SHORT,
                client,
                LinkingJobParams(motivation="linking", entity_types=["Person"]),
                build_annotation=text_build(SHORT),
                on_progress=handed.told,
                cancelled=handed.cancelled,
                on_unit_complete=handed.unit_complete,
                on_chunk_complete=handed.sink,
                resume_cursors=NOT_RESUMED,
                completed_units=NONE_FINISHED,
            ),
        )
        return answered, client, handed

    answered, client, handed = run(scenario())

    assert (len(client.asked), len(client.counted)) == (1, 1)
    assert [(checkpoint.unit, checkpoint.cursor.next) for checkpoint in handed.committed.checkpoints] == [("Person", END)]
    # Nothing was left to do but settle, and it is cancelled all the same.
    assert (answered, handed.finished) == (Cancelled(completed_units=["Person"]), ["Person"])
    assert "complete-created" not in handed.told.codes()


def test_a_linking_job_cancelled_as_a_type_s_last_batch_is_committed_stops_between_entity_types() -> None:
    limits = window(estimate_tokens(mention_prompt("", ["Person"], include_descriptive_references=False, source_language=None)) + 600)
    client = Model(limits, [[{"exact": "alpha", "entityType": "Person"}]], ["1"], None)
    handed = Handed(1)
    cancelling_as_it_commits(handed)

    answered = run(
        process_reference_job(
            SHORT,
            client,
            LinkingJobParams(motivation="linking", entity_types=["Person", "Place"]),
            build_annotation=text_build(SHORT),
            on_progress=handed.told,
            cancelled=handed.cancelled,
            on_unit_complete=handed.unit_complete,
            on_chunk_complete=handed.sink,
            resume_cursors=NOT_RESUMED,
            completed_units=NONE_FINISHED,
        )
    )

    # The second type was never asked for.
    assert (len(client.asked), len(client.counted)) == (1, 1)
    assert (answered, handed.finished) == (Cancelled(completed_units=["Person"]), ["Person"])
    assert "complete-created" not in handed.told.codes()


# ── a `yield` job stops before it uploads ───────────────────────────────

CONTEXT: Final[JsonValue] = {
    "focus": {"kind": "resource", "resource": {"@context": "https://schema.org", "@id": "src-1", "name": "Source", "representations": []}},
    "graph": {"nodes": [{"id": "src-1", "type": "resource", "label": "Source"}], "edges": []},
    "metadata": {},
}


def yielding(stated: dict[str, JsonValue]) -> GenerationJobParams:
    return GenerationJobParams.model_validate({"title": "T", "storageUri": "file://generated/t.md", "context": CONTEXT, **stated})


def generate(handed: Handed, params: GenerationJobParams) -> GeneratedArtifact | Cancelled:
    return run(process_generation_job(handed.client, params, on_progress=handed.told, cancelled=handed.cancelled))


def test_a_yield_job_cancelled_by_the_time_its_model_has_answered_makes_nothing_of_the_answer_and_reports_nothing_more(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Q3 and Q5.
    handed = Handed(1)

    def answer(_asked: AskedToGenerate) -> GeneratedDocument:
        # The cancellation arrives while the generation is under way.
        handed.cancelled.set(True)
        return GeneratedDocument(content="A claim. [[src-1]]", truncated=False)

    asked = generation_stood_in(monkeypatch, answer)

    assert generate(handed, yielding({"cite": True})) == Cancelled(completed_units=[])
    assert len(asked) == 1
    assert handed.told.said() == [report(5, {"code": "generating-resource"}, {})]


@pytest.mark.parametrize("cancelled_on", [1, 2])
def test_a_yield_job_to_pdf_cancelled_while_its_model_writes_compiles_nothing_of_that_answer_be_it_the_first_or_a_repair(
    monkeypatch: pytest.MonkeyPatch, cancelled_on: int
) -> None:
    handed = Handed(1)
    asked: list[AskedToGenerate] = []

    def answer(call: AskedToGenerate) -> GeneratedDocument:
        asked.append(call)
        if len(asked) == cancelled_on:
            handed.cancelled.set(True)
        return GeneratedDocument(content=f"= Attempt {len(asked)}", truncated=False)

    generation_stood_in(monkeypatch, answer)
    compiled = compiler_stood_in(monkeypatch, [NotCompiled(error="error: unclosed delimiter"), Compiled(pdf=b"%PDF")])

    assert generate(handed, yielding({"outputMediaType": "application/pdf"})) == Cancelled(completed_units=[])
    # What was written by the time the cancellation had arrived is not compiled.
    assert (len(asked), compiled) == (cancelled_on, [f"= Attempt {n}" for n in range(1, cancelled_on)])
    assert handed.told.said() == [report(5, {"code": "generating-resource"}, {})]


def test_a_yield_job_cancelled_once_its_model_has_answered_runs_to_its_end(monkeypatch: pytest.MonkeyPatch) -> None:
    # Q3: past the model's answer the job is settled as it would have been. Nothing here looks again.
    handed = Handed(1)
    generation_stood_in(monkeypatch, lambda _asked: GeneratedDocument(content="Body.", truncated=False))

    def told(progress: JobProgress) -> None:
        handed.told(progress)
        # The cancellation arrives once the document is being made of the answer.
        if progress.percentage == 95:
            handed.cancelled.set(True)

    made = run(process_generation_job(handed.client, yielding({}), on_progress=told, cancelled=handed.cancelled))

    assert isinstance(made, GeneratedText)
    assert made.content == b"Body."
    assert handed.told.codes() == ["generating-resource", "creating-resource", "complete-generated"]
