"""The pieces of a text a unit asks its model about.

It is three things: the budget a unit opens with, the walk over the text, and
the descent into a piece whose reply failed.

A budget is arithmetic over the provider's limits and the prompt around the
text. Nothing about the text enters it: no density, and no expected yield.
The walk then cuts each piece only after the one before has answered, so that
what a piece cost sizes the next (`semiont_worker.detection.chunk_size`). A
piece whose reply fails in a way a smaller piece can fix is asked again in
smaller pieces where it stands, and a failure a smaller piece cannot fix is
raised as it was. `specs/src/worker/chunk-plan-cases.json` holds the rule, as
its `budget`, `walk` and `descent`.
"""

import math
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Final, final

from pydantic import JsonValue
from semiont.types import UnitCursor
from semiont_inference.interface import InferenceLimits, StructuredReadError, TokenUsage

from semiont_worker.chunking import Chunking, chunk_text, cut_chunk
from semiont_worker.detection.chunk_size import CallOutcome, SizingBounds, next_chunk_size
from semiont_worker.failure_class import DeterministicJobError
from semiont_worker.inference_call import INFERENCE_TIMEOUT_SECONDS, InferenceTimeoutError
from semiont_worker.log import LOG
from semiont_worker.telemetry import DetectionLabel, DetectionOutcome, record_detection_call

OVERLAP_TOKENS: Final = 64
"""What each cut keeps of the piece before, in tokens: 256 code points.

A span is told from its repeats by up to 64 code points before it and 64
after. The overlap lets a span at a cut carry both, and as much again for
itself, into the next piece, so that one of the two pieces sees it whole.
"""

MAX_SUBDIVISION_DEPTH: Final = 2
"""How many levels a piece descends for a failure its size does not bound.

There are two: a call that ran out of time, and a reply unreadable from a
model that finished. A call that still runs out of time on a quarter of the
piece is not failing for its size, and a model that cannot be read at a
quarter of it is answering the prompt wrongly everywhere, where every level
more reads the same text for the same verdict. A reply that was cut off
descends by size instead.
"""

DETECTION_TEMPERATURE: Final = 0
"""The temperature of every call a `mark` job makes.

A detection copies spans word for word, against a closed list of kinds. That
asks for fidelity, so the same text is to give the same answer each time it
is asked about.
"""

YIELD_COLLAPSE_BAND: Final = 2
"""How far under a count of the same piece a reply may fall and not be taken to have missed mentions.

A reply that found fewer than one part in this many of what the count
reports is flagged. A model counts sometimes by entity and sometimes by
mention on the same text, and that honest spread has to fall inside the
band: at two, sound replies do and collapsed ones do not.
"""

_SECONDS_PER_HOUR: Final = 3600

ASSUMED_OUTPUT_TOKENS_PER_HOUR: Final = 108_000
"""The rate taken of a provider that states none: thirty tokens a second.

A provider with no stated rate and no bound of this kind would be sized by
its window alone, and a model stuck repeating itself would then write until
the bound on the call ended it, as a failure that is retried the same way.
Under this rate the same model is cut off in minutes, which a smaller piece
can fix. It is one rate for every model, and a low one on purpose: local
models measure faster, and one slower than half of it is stuck, not working.
"""


@final
@dataclass(frozen=True, slots=True)
class UnderReportedPiece:
    """What a piece kept at the size floor found, against what a count of the same piece reported: the facts, and no judgement of them."""

    found: int
    counted: int
    piece_chars: int
    """The piece's length, in code points."""


@final
class YieldCollapseError(DeterministicJobError):
    """A reply that read cleanly and found a fraction of what a count of the same piece says is there.

    It is a kind of `DeterministicJobError`: the same piece asked again gives
    the same under-report, so a retry is spent for nothing, and a smaller
    piece is what can fix it. Where the piece cannot be cut smaller it is not
    asked again: `salvage`, what the reply did find, is kept, and `verdict`
    is reported beside it. Both ride on the failure because whoever raises it
    cannot know whether a smaller piece is still possible.
    """

    def __init__(self, message: str, salvage: Sequence[JsonValue], verdict: UnderReportedPiece) -> None:
        super().__init__(message)
        self.salvage: Final = salvage
        self.verdict: Final = verdict


def assert_not_truncated(stop_reason: str, label: str, at: int, total_chars: int, output_budget: int) -> None:
    """Refuse a reply the model was cut off in, whatever it carried: raises a `DeterministicJobError` for a `stop_reason` of `max_tokens`.

    A reply cut off mid-array can still read as an array, of fewer elements
    than the model had to give. Taken as it is, it would under-report without
    a word, so it fails instead. The same text is cut off the same way again,
    which is why the failure is one no retry is spent on, and one a smaller
    piece can fix.

    `label` says whose reply it was, and `at` the offset of the piece in a
    text of `total_chars` code points.
    """
    if stop_reason == "max_tokens":
        raise DeterministicJobError(
            f"{label} response truncated (max_tokens) on the piece at offset {at} of a text of {total_chars} code points, "
            f"despite the derived output budget of {output_budget} tokens — failing the job rather than under-reporting annotations."
        )


@final
@dataclass(frozen=True, slots=True)
class DetectionBudget:
    """What a unit opens with.

    `chunking` is the size the first piece is cut at and the overlap every
    cut keeps. The size is where the walk opens, and the step moves it within
    `bounds` as the text reports what it costs. `bounds.output_budget` is the
    most one call may answer: it is what every call of the unit is given as
    its limit, and what a piece's use is measured against.
    """

    chunking: Chunking
    bounds: SizingBounds


def derive_detection_budget(limits: InferenceLimits, scaffold_tokens: int, types_per_call: int) -> DetectionBudget:
    """The budget of a unit, from its provider's limits and the prompt around the text.

    `scaffold_tokens` is the tokens of the prompt around an empty text.
    `types_per_call` is how many families of span one call asks for: the
    reply a call needs grows with each, so the text it may carry shrinks.

    Raises a `DeterministicJobError` when the window leaves the text one
    overlap or less: a piece of it would read nothing new, and the same
    window refuses the same job on every attempt.
    """
    context_tokens, max_output_tokens = limits.context_tokens, limits.max_output_tokens
    available = context_tokens - scaffold_tokens

    if max_output_tokens >= context_tokens:
        # One window for prompt and reply: a third of what the scaffold leaves is text, and the rest is reply.
        # A reply repeats each span of the text with its context, so it needs the larger share.
        input_budget = available // 3
        output_budget = available - input_budget
    else:
        # A reply ceiling of its own.
        output_budget = max_output_tokens
        input_budget = context_tokens - output_budget - scaffold_tokens
        if input_budget <= 0:
            # The ceiling nearly fills the window: the shared split, and not a text of nothing.
            input_budget = available // 3
            output_budget = available - input_budget

    # A call must end inside the bound on it. Half the bound, at the provider's rate: at the whole bound the
    # slowest honest reply would end exactly as the bound does, and at half it ends only a call twice as slow
    # as the provider's own worst. The text shrinks by the same factor, so the two keep their proportion.
    rate = ASSUMED_OUTPUT_TOKENS_PER_HOUR if limits.output_tokens_per_hour is None else limits.output_tokens_per_hour
    duration_safe_output = rate * (INFERENCE_TIMEOUT_SECONDS // 2) // _SECONDS_PER_HOUR
    if output_budget > duration_safe_output:
        input_budget = math.floor(input_budget * (duration_safe_output / output_budget))
        output_budget = duration_safe_output

    # The most text that leaves the whole reply room beside it. It is the one hard bound on the text there is,
    # and so the step's ceiling: the split above and the rule below are guesses at what a piece will demand,
    # which the step replaces with what pieces are measured to cost.
    capacity_input = context_tokens - scaffold_tokens - output_budget

    # The reply must have room to repeat every span of the text, for each family of span asked for: a piece
    # over half the reply is a call whose honest answer cannot fit.
    input_budget = min(input_budget, output_budget // (2 * types_per_call))

    if input_budget <= OVERLAP_TOKENS:
        raise DeterministicJobError(
            f"Inference window too small for detection: context {context_tokens} tokens minus scaffold {scaffold_tokens} "
            f"leaves an input budget of {input_budget} (need > {OVERLAP_TOKENS}). "
            "Use a model with a larger context window or reduce the prompt scaffold."
        )

    return DetectionBudget(
        chunking=Chunking(chunk_size=input_budget, overlap=OVERLAP_TOKENS),
        bounds=SizingBounds(
            # Two overlaps: at the floor a piece is still half text the unit has not seen. Never above the
            # opening size, which a cramped window can put below even that.
            floor=min(input_budget, 2 * OVERLAP_TOKENS),
            # Never below the opening size, which a cramped window can leave above what fits.
            ceiling=max(input_budget, capacity_input),
            output_budget=output_budget,
        ),
    )


@final
@dataclass(frozen=True, slots=True)
class ChunkCursor:
    """Where a unit's walk stands once a piece is committed, and how it is cutting: the two members of a unit's cursor a walk can state.

    The tallies of a unit's cursor are whoever makes the annotations' to
    count. A walk counts pieces and no annotations, and a zero it made up
    would read as one it had counted.
    """

    next: int
    size: int


@final
@dataclass(frozen=True, slots=True)
class AdaptiveChunk:
    """One piece the walk hands out, with where it stands in the text. Each position is an offset: it counts the text's code points."""

    piece: str
    size: int
    """The size the piece was cut at, in tokens. A descent into the piece halves from this size, and not from the walk's opening size."""
    at: int
    """Where the piece starts."""
    next: int
    """Where the next piece starts, or the length of the text after the last. The unit's cursor records it once the piece is committed."""
    total_chars: int
    """The length of the text."""


async def run_adaptive_chunks(
    text: str,
    budget: DetectionBudget,
    on_chunk: Callable[[AdaptiveChunk], Awaitable[CallOutcome]],
    resume: UnitCursor | None,
) -> None:
    """Walk `text` in pieces, each cut only after the one before has answered.

    The first piece is cut at 0 at the budget's opening size. Each next one is
    cut where the last one's `next` stands, at the size the step gives for the
    last one's size and what `on_chunk` answered it cost. The walk ends when a
    piece reaches the end of the text. `on_chunk` is awaited, so whatever it
    makes durable is durable before the next cut, and a failure it raises
    stops the walk where it stands. Nothing else stops it: the walk does not
    look for a cancellation of the job it works for.

    `resume` is where an earlier attempt left the unit. The walk starts at
    the cursor's `next`, at the size the step gives for the cursor's `size`
    and a size failure: the attempt that wrote the cursor died, the same size
    would cut the same piece and be answered the same way, and the opening
    size would throw away what that attempt learned. A cursor at the end of
    the text asks nothing.
    """
    total_chars = len(text)
    if resume is None:
        at, size = 0, budget.chunking.chunk_size
    else:
        at, size = resume.next, next_chunk_size(CallOutcome(size_failed=True, output_tokens=None), resume.size, budget.bounds)

    while at < total_chars:
        cut = cut_chunk(text, at, Chunking(chunk_size=size, overlap=budget.chunking.overlap))
        outcome = await on_chunk(AdaptiveChunk(piece=cut.piece, size=size, at=at, next=cut.next, total_chars=total_chars))
        at = cut.next
        size = next_chunk_size(outcome, size, budget.bounds)


@final
@dataclass(frozen=True, slots=True)
class ChunkCallResult:
    """What one call about one piece answered."""

    items: Sequence[JsonValue]
    """The elements the model wrote, as parsed."""
    usage: TokenUsage | None
    """What the provider counted, where it counted. It is never estimated."""
    counted: int | None
    """How many mentions a count of the same piece reported, where one was asked for."""


@final
@dataclass(frozen=True, slots=True)
class SubdividedCall:
    """What a piece gave over however many calls its descent took, and what it cost."""

    items: list[JsonValue]
    """Those of every piece that was accepted, in order."""
    outcome: CallOutcome
    """What the step sizes the next piece from: whether any call size-failed, and what the provider counted over the calls that answered."""


async def call_chunk_subdividing(
    label: DetectionLabel,
    chunk: str,
    chunking: Chunking,
    call: Callable[[str], Awaitable[ChunkCallResult]],
    on_under_report: Callable[[UnderReportedPiece], None] | None,
    on_counted: Callable[[int], None] | None,
) -> SubdividedCall:
    """Ask about one piece of a walk, and ask again in smaller pieces when its reply fails in a way a smaller piece can fix.

    `chunk` was cut at `chunking`'s size, and `call` asks the model about the
    piece it is given. `label` is what the descent's calls are filed under in
    telemetry. A reply that answers is accepted. Four failures are
    ones a smaller piece can fix: a reply that was cut off, one unreadable
    for a reason the provider did not state, one unreadable from a model that
    finished, and a call that ran out of time. Any other is raised as it was.

    For one of the four the piece is cut whole at half its size, with the
    same overlap, and each smaller piece is asked about in turn, one level
    down. It descends only if that changes what is asked. A reply cut off, or
    unreadable for no stated reason, descends for as long as the half size is
    over two overlaps: what a piece demands halves with its size. One that
    ran out of time, or was unreadable from a model that finished, descends
    two levels at most: a quarter of the piece that still fails is not
    failing for its size.

    A piece that does not descend is settled where it stands. A yield
    collapse is accepted with what it found, and its verdict reported. Any
    other cut-off reply is asked for once more, and that answer or failure
    stands. Anything else is raised.

    The descent tells its caller two things as it goes, where the caller
    gives it someone to tell. `on_counted` is told the count of each piece as
    it is accepted: of an answer that had one, and of a collapse that is
    kept. A piece that descends tells none: its smaller pieces' counts stand
    in its place. `on_under_report` is told the verdict of each collapse that
    is kept. Both are told at once, and not when the descent ends, so what
    was accepted before a later piece failed has still been told.
    """
    descent = _Descent(label, chunking.overlap, call, on_under_report, on_counted)
    items = await descent.attempt(chunk, chunking.chunk_size, 0)
    return SubdividedCall(items=items, outcome=CallOutcome(size_failed=descent.size_failed, output_tokens=descent.output_tokens))


def _cut_off(failure: BaseException) -> bool:
    """Whether a reply was cut off: read and found to be, or unreadable for having been."""
    return isinstance(failure, DeterministicJobError) or (isinstance(failure, StructuredReadError) and failure.stop_reason == "max_tokens")


def _unreadable_for_no_stated_reason(failure: Exception) -> bool:
    """Whether a reply could not be read and the provider did not say why the model stopped.

    It goes with size: it comes beside cut-off replies that smaller pieces
    cure, and the same piece asked again gives the same reply. So it descends
    as a cut-off reply does. At the size floor it is not asked for again,
    since nothing of it can be kept, and it is left unclassified, since a
    server that is really broken deserves its retries.
    """
    return isinstance(failure, StructuredReadError) and failure.stop_reason == "unknown"


def _unreadable_though_finished(failure: Exception) -> bool:
    """Whether a reply could not be read from a model that finished: not cut off, and not stopped for no stated reason.

    A smaller piece can fix it where the text set the model off, which the
    same piece asked again cannot. Where the model answers the prompt wrongly
    everywhere it cannot, so the descent is bounded by its depth.
    """
    return isinstance(failure, StructuredReadError) and failure.stop_reason == "end_turn"


def _outcome_of(failure: BaseException) -> DetectionOutcome:
    """How a call that failed is filed: the kinds of failure ask for opposite things, so the record tells them apart."""
    # A collapse before a cut-off reply: it is a kind of `DeterministicJobError`, and would be taken for one.
    if isinstance(failure, YieldCollapseError):
        return "collapsed"
    if _cut_off(failure):
        return "truncated"
    if isinstance(failure, InferenceTimeoutError):
        return "timeout"
    return "error"


@final
class _Descent:
    """One piece's descent: what its calls have cost, and what it tells of each as it goes."""

    def __init__(
        self,
        label: DetectionLabel,
        overlap: int,
        call: Callable[[str], Awaitable[ChunkCallResult]],
        on_under_report: Callable[[UnderReportedPiece], None] | None,
        on_counted: Callable[[int], None] | None,
    ) -> None:
        self._label: Final[DetectionLabel] = label
        self._overlap: Final = overlap
        self._call: Final = call
        self._on_under_report: Final = on_under_report
        self._on_counted: Final = on_counted
        self._answered = 0
        self._counted_by_the_provider = 0
        self._output_tokens = 0
        self.size_failed = False

    @property
    def output_tokens(self) -> int | None:
        """What the provider counted over the calls that answered, where at least one did and every one was counted.

        A sum that is missing a call under-counts, and under-counting argues
        for a larger piece: the one step that costs a cut-off reply to find
        was wrong.
        """
        return self._output_tokens if 0 < self._answered == self._counted_by_the_provider else None

    async def _ask(self, piece: str, depth: int, *, reroll: bool) -> list[JsonValue]:
        """Ask about `piece`, and take what an answer says of its cost and its count. An answer is always accepted.

        The call is recorded however it ends, here where its `depth` and
        whether it is a second asking are known. One that failed still cost
        what it was sent and the time it took, and so did one its caller
        cancelled.
        """
        started = time.perf_counter()
        try:
            answer = await self._call(piece)
        except BaseException as failure:
            record_detection_call(
                label=self._label, started=started, items=0, depth=depth, reroll=reroll, outcome=_outcome_of(failure), usage=None
            )
            raise
        record_detection_call(
            label=self._label, started=started, items=len(answer.items), depth=depth, reroll=reroll, outcome="success", usage=answer.usage
        )
        self._answered += 1
        if answer.usage is not None:
            self._counted_by_the_provider += 1
            self._output_tokens += answer.usage.output_tokens
        if answer.counted is not None and self._on_counted is not None:
            self._on_counted(answer.counted)
        return list(answer.items)

    async def attempt(self, piece: str, chunk_size: int, depth: int) -> list[JsonValue]:
        """What `piece`, cut at `chunk_size` and `depth` levels below the piece the descent began with, gives."""
        try:
            return await self._ask(piece, depth, reroll=False)
        except (DeterministicJobError, StructuredReadError, InferenceTimeoutError) as failure:
            by_size = _cut_off(failure) or _unreadable_for_no_stated_reason(failure)
            by_depth = isinstance(failure, InferenceTimeoutError) or _unreadable_though_finished(failure)
            if not (by_size or by_depth):
                raise
            # The size was wrong, whether or not the descent below recovers the piece: the next piece of the
            # walk is not to be cut at a size this one has already paid to find too large.
            self.size_failed = True
            half = chunk_size // 2
            # A descent must change what is asked. A piece already within the half size is cut into itself,
            # and the same call gives the same failure: it stands at its floor, whatever the arithmetic says.
            smaller = chunk_text(piece, Chunking(chunk_size=half, overlap=self._overlap))
            shrinks = smaller != [piece]
            # By size, a piece descends for as long as its half is over two overlaps: what a piece demands
            # halves with its size, so this ends, and a text dense with spans goes as deep as it needs.
            if shrinks and (half > 2 * OVERLAP_TOKENS if by_size else depth < MAX_SUBDIVISION_DEPTH):
                LOG.warning(
                    "Chunk call failed at a size-shaped bound — subdividing and retrying smaller",
                    extra={"depth": depth + 1, "pieceChars": len(piece), "nextChunkSizeTokens": half, "error": str(failure)},
                )
                # What the failed reply carried is discarded for what the smaller pieces give.
                collected: list[JsonValue] = []
                for part in smaller:
                    collected.extend(await self.attempt(part, half, depth + 1))
                return collected
            if isinstance(failure, YieldCollapseError):
                # Kept, and said: one piece does not discard its unit's work, and asking again gives the same collapse.
                LOG.warning(
                    "Floor-size piece still flagged as collapsed — accepting its under-reported salvage and continuing",
                    extra={"pieceChars": len(piece), "salvaged": len(failure.salvage), "error": str(failure)},
                )
                if self._on_under_report is not None:
                    self._on_under_report(failure.verdict)
                if self._on_counted is not None:
                    self._on_counted(failure.verdict.counted)
                return list(failure.salvage)
            if not _cut_off(failure):
                raise
            # At the size floor an honest reply fits, so a cut-off one is a model repeating itself: once more, and no more.
            LOG.warning(
                "Floor-size piece truncated — re-rolling once before giving up", extra={"pieceChars": len(piece), "error": str(failure)}
            )
            return await self._ask(piece, depth, reroll=True)
