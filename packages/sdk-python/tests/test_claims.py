"""`job.claim`: a worker's claims and the jobs it comes to hold.

The rules are docs/protocol/WORKER-CONTRACT.md's, and the worker conformance
suite (tests/conformance/worker) holds them on the wire. These are the same
rules over a transport the test answers by hand: the stand-in dispatcher
below answers each `job:claim` with what a test offered, refused, or with
nothing pending, and the stand-in record answers each commit and each
question asked about one. Two tables are run here too: whether a job matches
a filter, and whether a failed job is retried.
"""

import asyncio
from collections import deque
from collections.abc import AsyncGenerator, Generator, Mapping, Sequence
from contextlib import asynccontextmanager, contextmanager
from typing import Final

import pytest
from aio import hurried, pass_time, run, soon, turns
from opentelemetry import context as otel_context
from opentelemetry import trace as otel_trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags
from pydantic import BaseModel, Field, JsonValue, TypeAdapter
from spec import SPEC, JsonObject, objects, read, text

from semiont.claims import (
    JOB_CLAIM_CHANNELS,
    JOB_COMMIT_CHANNELS,
    ClaimRefusal,
    Claims,
    HeldJob,
    HeldMarkJob,
    HeldYieldJob,
    will_retry_after,
)
from semiont.client import SemiontClient
from semiont.errors import BusRequestError, TransportError
from semiont.identifiers import ResourceId
from semiont.job_filter import job_matches_filter
from semiont.testing import (
    Delay,
    Deliver,
    DropReply,
    FaultAction,
    FaultyTransport,
    InMemoryContent,
    RejectEmit,
    RequestLogEntry,
    StubGateway,
)
from semiont.timing import MARK_COMMIT_TIMEOUT_MS
from semiont.transport import Frame, TraceContext
from semiont.types import (
    Annotation,
    DurabilityEvidence,
    FailureClass,
    JobDetectionResult,
    JobFilter,
    JobGenerationResult,
    JobProgress,
    UnitCursor,
)
from semiont.watched import Watched

_FILTERS: Final = TypeAdapter[list[JobFilter]](list[JobFilter])
EVERYTHING: Final = _FILTERS.validate_python(
    [
        *(
            {"jobType": "mark", "params": {"motivation": motivation}}
            for motivation in ("highlighting", "commenting", "assessing", "linking", "tagging")
        ),
        {"jobType": "yield"},
    ]
)
TAGGING: Final = _FILTERS.validate_python([{"jobType": "mark", "params": {"motivation": "tagging"}}])

RESOURCE: Final = ResourceId("res-1")
REQUESTS: Final = ("job:claim", "mark:commit", "browse:annotation-requested")
"""What a worker asks and waits to be answered: its claims, its commits, and the question an unacknowledged commit asks."""
NOT_THERE: Final[JsonObject] = {"message": "Annotation not found"}
"""What the record answers when it is asked of an annotation it does not hold."""
QUICK: Final = 200
"""A commit's wait, in milliseconds, for a scenario that passes the loop's clock a step at a time."""


def running(job_id: str, job_type: str = "mark", *, metadata: JsonObject | None = None, params: JsonObject | None = None) -> JsonObject:
    """A running job as the dispatcher returns one from a claim."""
    return {
        "status": "running",
        "metadata": {
            "id": job_id,
            "type": job_type,
            "userId": "did:web:kb.example:users:u",
            "created": "2026-01-01T00:00:00.000Z",
            "retryCount": 0,
            "maxRetries": 1,
            **(metadata or {}),
        },
        "params": {"resourceId": "res-1", **(params or {})},
        "startedAt": "2026-01-01T00:00:01.000Z",
        "progress": {},
    }


def queued(motivation: str) -> JsonObject:
    """An announcement of a `mark` job of `motivation`.

    It states less than the spec has a tagging job state, on purpose: an
    announcement is compared with a claim as it came, so one this SDK could
    not type still wakes a worker whose claim it matches.
    """
    return {
        "jobId": "job-announced",
        "jobType": "mark",
        "resourceId": "res-9",
        "userId": "did:web:kb.example:users:u",
        "params": {"motivation": motivation},
    }


def annotation(annotation_id: str) -> JsonObject:
    """An annotation as the wire carries one: already made, with its id."""
    return {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": annotation_id,
        "motivation": "highlighting",
        "target": {"source": "res-1", "selector": {"type": "TextQuoteSelector", "exact": f"the words of {annotation_id}"}},
        "created": "2026-01-01T00:00:00.000Z",
    }


def made(annotation_id: str) -> Annotation:
    """That annotation, as a worker hands one to a commit."""
    return Annotation.model_validate(annotation(annotation_id))


class World:
    """A client, a stand-in dispatcher that answers its claims, and a stand-in record that answers its commits.

    The record acknowledges every commit, and answers every question about an
    annotation with that annotation, unless a test has it do otherwise. What
    the `wire` does to each request in turn is the transport's schedule: a
    reply it drops is an answer nobody receives.
    """

    def __init__(self, *, channels: tuple[str, ...] | None = None, wire: Sequence[FaultAction] = ()) -> None:
        self.offered: Final[deque[JsonObject]] = deque()
        self.refusals: Final[deque[JsonObject]] = deque()
        self.refusing_commits = False
        """Whether the record refuses each commit, where it would acknowledge it."""
        self.asked_of: Final[dict[str, JsonObject]] = {}
        """The failure the record answers a question about an annotation with, by the annotation's id."""
        self.claimed_in: Final[list[str | None]] = []
        """The trace each claim was made in, in order: its id, or nothing for a claim made in none."""
        self.transport: Final = FaultyTransport(wire, make_response=self._answer, channels=channels)
        self.transport.refuse_when(self._refusal)
        self.client: Final = SemiontClient(self.transport, InMemoryContent(), StubGateway())

    def _refusal(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonObject | None:
        match operation:
            case "job:claim":
                # Asked as the claim is sent, so where the claim is made is where this runs.
                made_in = otel_trace.get_current_span().get_span_context()
                self.claimed_in.append(f"{made_in.trace_id:032x}" if made_in.is_valid else None)
                if self.refusals:
                    return self.refusals.popleft()
                return None if self.offered else {"message": "No pending job matches", "code": "none-pending"}
            case "mark:commit":
                return {"message": "the record could not append"} if self.refusing_commits else None
            case "browse:annotation-requested":
                return self.asked_of.get(text(payload["annotationId"], "annotationId"))
            case _:
                return None

    def _answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue:
        match operation:
            case "job:claim":
                return self.offered.popleft()
            case "mark:commit":
                ids = [committed["id"] for committed in objects(payload["annotations"], "annotations")]
                return {"persisted": len(ids), "annotationIds": ids}
            case "browse:annotation-requested":
                return {"annotation": annotation(text(payload["annotationId"], "annotationId")), "resource": None, "resolvedResource": None}
            case _:
                raise AssertionError(f"nothing is scripted to answer {operation}")

    def relay(self, channel: str, payload: JsonObject) -> None:
        """A broadcast the gateway relays to this worker."""
        self.transport.deliver(Frame(channel=channel, payload=payload))

    def sent(self, channel: str) -> list[JsonObject]:
        return [dict(frame.payload) for frame in self.transport.emitted if frame.channel == channel]

    def requested(self, operation: str) -> list[RequestLogEntry]:
        """Every request of `operation` sent so far, in order."""
        return [entry for entry in self.transport.request_log if entry.channel == operation]

    def said(self) -> list[tuple[str, JsonObject]]:
        """Everything said that is not a request: the lifecycle, in order. Each is global, and nobody's reply."""
        said: list[tuple[str, JsonObject]] = []
        for frame in self.transport.emitted:
            if frame.channel not in REQUESTS:
                assert (frame.scope, frame.correlation_id) == (None, None), frame.channel
                said.append((frame.channel, dict(frame.payload)))
        return said

    async def over(self) -> None:
        await self.client.close()
        await self.transport.close()


@contextmanager
def in_span(digit: int) -> Generator[None]:
    """Be inside a span of the trace `digit` names, as a worker's code is inside the span it opened for a job."""
    span = NonRecordingSpan(
        SpanContext(
            trace_id=int(str(digit) * 32, 16), span_id=int(str(digit) * 16, 16), is_remote=False, trace_flags=TraceFlags(TraceFlags.SAMPLED)
        )
    )
    token = otel_context.attach(otel_trace.set_span_in_context(span))
    try:
        yield
    finally:
        otel_context.detach(token)


async def held(claims: Claims) -> HeldJob:
    """The job the claims hand out next."""
    handed = await soon(anext(claims), within=2.0)
    assert not isinstance(handed, ClaimRefusal), handed
    return handed


async def finish(job: HeldJob) -> None:
    """Complete a held `mark` job that found nothing. A completion is its verb's, so the verb is read first."""
    assert isinstance(job, HeldMarkJob)
    await job.complete(JobDetectionResult(found=0, persisted=0))


def now[T](watched: Watched[T]) -> T:
    """What `watched` holds at this moment: read again each time, since it changes under the test."""
    return watched.value


def wire_for(*observed: DurabilityEvidence) -> list[FaultAction]:
    """What the wire does to each request of a worker that claims one job and commits once for each of `observed`, in order.

    A schedule counts every request: the claim, each commit, and the question
    that follows a commit whose acknowledgement is lost. A lost
    acknowledgement is a reply the wire drops, and so is an answer to the
    question that never comes.
    """
    wire: list[FaultAction] = [Deliver()]
    for how in observed:
        match how:
            case "acknowledged":
                wire.append(Deliver())
            case "probe-confirmed" | "probe-refused":
                wire.extend((DropReply(), Deliver()))
            case "probe-unreachable":
                wire.extend((DropReply(), DropReply()))
    # The claim the settle makes.
    wire.append(Deliver())
    return wire


async def commit_observing(w: World, job: HeldJob, how: DurabilityEvidence, annotation_id: str = "ann-1") -> BusRequestError | None:
    """Commit one annotation, the record played so that the commit observes `how` on a wire that is `wire_for` it.

    Nothing when the commit is established, and what it raised when it is not.
    """
    if how == "probe-refused":
        w.asked_of[annotation_id] = NOT_THERE
    try:
        await hurried(job.commit(RESOURCE, [made(annotation_id)]))
    except BusRequestError as failed:
        return failed
    return None


@asynccontextmanager
async def having_committed(*observed: DurabilityEvidence) -> AsyncGenerator[tuple[World, HeldJob]]:
    """A worker that holds `job-1` and has committed once for each of `observed`, in order. Leaving the block stops it."""
    w = World(wire=wire_for(*observed))
    w.offered.append(running("job-1"))
    async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
        job = await held(claims)
        for at, how in enumerate(observed):
            failed = await commit_observing(w, job, how, f"ann-{at}")
            if how in ("acknowledged", "probe-confirmed"):
                assert failed is None, f"{how} establishes the commit"
            else:
                assert failed is not None, f"{how} does not"
                assert failed.code == "bus.timeout"
        assert len(w.sent("mark:commit")) == len(observed)
        yield w, job
    await w.over()


# ── The two tables ──────────────────────────────────────────────


class FilterCase(BaseModel):
    """A row of specs/src/jobs/filter-cases.json."""

    why: str
    filter: JsonObject
    job: JsonObject
    matches: bool


class RetryCase(BaseModel):
    """A row of specs/src/jobs/retry-cases.json."""

    why: str
    retry_count: int = Field(alias="retryCount")
    max_retries: int = Field(alias="maxRetries")
    failure_class: FailureClass | None = Field(default=None, alias="failureClass")
    retries: bool


def test_whether_a_job_matches_a_filter_is_the_tables_answer() -> None:
    cases = [FilterCase.model_validate(case) for case in objects(read(SPEC / "jobs/filter-cases.json")["cases"], "cases")]
    for case in cases:
        assert job_matches_filter(case.filter, case.job) is case.matches, case.why
    assert {case.matches for case in cases} == {True, False}, "the table asks both ways"


def test_whether_a_failed_job_is_retried_is_the_tables_answer() -> None:
    cases = [RetryCase.model_validate(case) for case in objects(read(SPEC / "jobs/retry-cases.json")["cases"], "cases")]
    assert cases
    for case in cases:
        assert will_retry_after(case.retry_count, case.max_retries, case.failure_class) is case.retries, case.why


# ── A worker claims when it becomes idle, and at no other time ──


def test_claims_nothing_until_read_then_claims_and_holds_the_job_as_the_record_states_it() -> None:
    async def scenario() -> None:
        w = World()
        cursor: JsonObject = {"next": 1200, "size": 800, "found": 4, "emitted": 3, "errors": 0}
        w.offered.append(
            running(
                "job-1",
                metadata={"retryCount": 1, "maxRetries": 3, "completedUnits": ["Person"], "unitCursors": {"Place": cursor}},
                params={"motivation": "highlighting", "density": 3},
            )
        )
        async with w.client.job.claim(EVERYTHING[:1]) as claims:
            await turns()
            assert w.sent("job:claim") == []

            job = await held(claims)
            assert w.sent("job:claim") == [{"accepts": [{"jobType": "mark", "params": {"motivation": "highlighting"}}]}]
            assert (job.job_id, job.job_type, job.resource_id) == ("job-1", "mark", "res-1")
            assert (job.retry_count, job.max_retries, job.attempt) == (1, 3, 2)
            assert list(job.completed_units) == ["Person"]
            assert {unit: cursor.next for unit, cursor in job.unit_cursors.items()} == {"Place": 1200}
            assert (job.annotation_id, job.cancelled.value, job.settled) == (None, False, False)
            await finish(job)
        await w.over()

    run(scenario())


def test_claims_again_when_a_job_is_settled_and_an_announcement_while_one_is_held_is_ignored() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.extend(running(job_id) for job_id in ("job-1", "job-2", "job-3"))
        async with w.client.job.claim(EVERYTHING) as claims:
            first = await held(claims)
            w.relay("job:queued", queued("highlighting"))
            await turns()
            assert len(w.sent("job:claim")) == 1, "no claim while holding a job"

            await finish(first)
            second = await held(claims)
            assert (len(w.sent("job:claim")), second.job_id) == (2, "job-2")
            await second.fail("kaboom")
            third = await held(claims)
            await third.cancel()
            await turns()
            assert len(w.sent("job:claim")) == 4, "the settle asks, and is told nothing is pending"
        await w.over()

    run(scenario())


def test_a_matching_announcement_claims_and_one_that_matches_no_filter_does_not() -> None:
    async def scenario() -> None:
        w = World()
        async with w.client.job.claim(TAGGING) as claims:
            reading = asyncio.ensure_future(held(claims))
            await turns()
            assert len(w.sent("job:claim")) == 1, "the first claim, answered with nothing pending"

            w.relay("job:queued", queued("highlighting"))
            await turns()
            assert len(w.sent("job:claim")) == 1, "no round trip for a job this worker does not take"

            w.offered.append(running("job-1", params={"motivation": "tagging"}))
            w.relay("job:queued", queued("tagging"))
            await finish(await reading)
            await turns()
            assert len(w.sent("job:claim")) == 3, "and the settle asks"
        await w.over()

    run(scenario())


def test_claims_when_the_stream_opens_and_when_it_opens_again() -> None:
    async def scenario() -> None:
        w = World()
        w.transport.set_state("connecting")
        async with w.client.job.claim(EVERYTHING) as claims:
            reading = asyncio.ensure_future(anext(claims))
            await turns()
            assert w.sent("job:claim") == [], "a claim on a closed stream would only be refused here"

            w.transport.set_state("open")
            await turns()
            assert len(w.sent("job:claim")) == 1
            w.transport.set_state("reconnecting")
            await turns()
            assert len(w.sent("job:claim")) == 1, "losing the stream claims nothing"
            w.transport.set_state("open")
            await turns()
            assert len(w.sent("job:claim")) == 2, "regaining it asks"
            reading.cancel()
        await w.over()

    run(scenario())


def test_a_refusal_is_handed_out_with_its_code_and_a_reply_that_names_no_job_is_refused_here() -> None:
    async def scenario() -> None:
        w = World()
        w.refusals.append({"message": "the caller is not a worker for this knowledge base", "code": "unauthorized"})
        async with w.client.job.claim(EVERYTHING) as claims:
            assert await soon(anext(claims)) == ClaimRefusal("bus.unauthorized", "the caller is not a worker for this knowledge base")
            assert len(w.sent("job:claim")) == 1, "it does not ask again by itself"

            # WORKER-CONTRACT C9: a worker must not run what it cannot read, and goes on claiming.
            w.offered.append({"status": "running"})
            w.relay("job:queued", queued("highlighting"))
            refused = await soon(anext(claims))
            assert isinstance(refused, ClaimRefusal), refused
            assert refused.code is None, "a failure of this worker's own, under no bus code"

            w.offered.append(running("job-1"))
            w.relay("job:queued", queued("highlighting"))
            await finish(await held(claims))
        await w.over()

    run(scenario())


def test_a_stream_that_does_not_name_what_claiming_reads_cannot_carry_a_workers_claims() -> None:
    assert JOB_CLAIM_CHANNELS == ("job:claimed", "job:claim-failed", "job:queued", "job:cancel-requested")

    async def scenario() -> None:
        # A worker on such a stream would claim once and never be woken, with nothing to show for it.
        w = World(channels=("job:claimed", "job:claim-failed"))
        claims = w.client.job.claim(EVERYTHING)
        with pytest.raises(BusRequestError) as refused:
            await anext(claims)
        assert refused.value.code == "bus.unsubscribed"
        assert "job:queued, job:cancel-requested" in refused.value.message
        assert w.sent("job:claim") == []
        await claims.aclose()
        await w.over()

    run(scenario())


# ── The held job ────────────────────────────────────────────────


def test_a_held_job_says_its_whole_lifecycle_itself() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(running("job-1", metadata={"retryCount": 1}))
        cursor: JsonObject = {"next": 1200, "size": 800, "found": 4, "emitted": 3, "errors": 0}
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            assert isinstance(job, HeldMarkJob)
            await job.start()
            await job.progress(JobProgress(percentage=40))
            await job.checkpoint(["Person"], {"Place": UnitCursor.model_validate(cursor)})
            assert await commit_observing(w, job, "acknowledged") is None
            await job.complete(JobDetectionResult(found=9, persisted=7))
            with pytest.raises(RuntimeError, match="already settled"):
                await job.fail("too late")

        identity: JsonObject = {"resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 2}
        assert w.said() == [
            ("job:start", identity),
            ("job:report-progress", {**identity, "percentage": 40, "progress": {"percentage": 40}}),
            ("job:checkpoint", {"jobId": "job-1", "completedUnits": ["Person"], "unitCursors": {"Place": cursor}}),
            ("job:complete", {**identity, "result": {"found": 9, "persisted": 7}, "durability": "acknowledged"}),
        ]
        await w.over()

    run(scenario())


def test_a_yield_job_focused_on_an_annotation_is_anchored_to_it_and_says_so() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(
            running(
                "job-1",
                "yield",
                metadata={"maxRetries": 0},
                params={"context": {"focus": {"kind": "annotation", "annotation": {"id": "ann-7"}}}},
            )
        )
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            assert isinstance(job, HeldYieldJob)
            assert job.annotation_id == "ann-7"
            await job.start()
            with pytest.raises(RuntimeError, match="first message"):
                await job.start()
            await job.progress(JobProgress(percentage=5))
            await job.complete(JobGenerationResult(resource_id=job.resource_id, resource_name="Ouranos", truncated=False))

        identity: JsonObject = {"resourceId": "res-1", "jobId": "job-1", "jobType": "yield", "attempt": 1, "annotationId": "ann-7"}
        said = w.said()
        assert said[0] == ("job:start", identity)
        assert said[1][1]["progress"] == {"percentage": 5, "annotationId": "ann-7"}
        made: JsonObject = {"resourceId": "res-1", "resourceName": "Ouranos", "truncated": False}
        assert said[2] == ("job:complete", {**identity, "result": made})
        await w.over()

    run(scenario())


def test_a_failure_says_whether_it_will_be_retried_and_a_cancel_says_only_what_its_command_names() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.extend(
            [
                running("job-1", metadata={"retryCount": 0, "maxRetries": 1}),
                running("job-2", metadata={"retryCount": 1, "maxRetries": 1}),
                running("job-3"),
            ]
        )
        async with w.client.job.claim(EVERYTHING) as claims:
            await (await held(claims)).fail("the model timed out", completed_units=["Person"])
            await (await held(claims)).fail("the model timed out")
            await (await held(claims)).cancel(["Person"])

        base: JsonObject = {"resourceId": "res-1", "jobType": "mark"}
        assert w.sent("job:fail") == [
            # A class the worker does not know is not stated.
            {**base, "jobId": "job-1", "attempt": 1, "error": "the model timed out", "completedUnits": ["Person"], "willRetry": True},
            {**base, "jobId": "job-2", "attempt": 2, "error": "the model timed out", "willRetry": False},
        ]
        assert w.sent("job:cancel") == [{**base, "jobId": "job-3", "completedUnits": ["Person"]}]
        await w.over()

        # A failure no second attempt can change, of a job one of whose commits was not established.
        async with having_committed("probe-refused") as (known, job):
            await job.fail("the resource has no text", failure_class="deterministic")
        assert known.sent("job:fail") == [
            {
                **base,
                "jobId": "job-1",
                "attempt": 1,
                "error": "the resource has no text",
                "failureClass": "deterministic",
                "willRetry": False,
                "durability": "probe-refused",
            }
        ]

    run(scenario())


def test_a_cancellation_that_names_the_held_job_is_signalled_and_any_other_is_not() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            w.relay("job:cancel-requested", {"jobId": "job-7"})
            await turns()
            assert now(job.cancelled) is False

            w.relay("job:cancel-requested", {"jobId": "job-1"})
            await turns()
            assert now(job.cancelled) is True
            await job.cancel()
        await w.over()

    run(scenario())


# WORKER-CONTRACT L8, and what Python has in place of a value being let go of.
def test_a_worker_that_stops_fails_the_job_it_holds_and_a_job_left_unsettled_is_failed() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.extend([running("job-1"), running("job-2")])
        async with w.client.job.claim(EVERYTHING) as claims:
            async with await held(claims):
                pass  # Held, and left without being settled.
            assert [said["error"] for said in w.sent("job:fail")] == ["The worker let go of the job without settling it"]

            stopped_with = await held(claims)
        # The worker stopped while it held the second.
        assert w.sent("job:fail")[1] == {
            "resourceId": "res-1",
            "jobId": "job-2",
            "jobType": "mark",
            "attempt": 1,
            "error": "The worker stopped while it held the job",
            "willRetry": True,
        }
        assert stopped_with.settled
        with pytest.raises(StopAsyncIteration):
            await anext(claims)
        assert len(w.sent("job:claim")) == 2, "and it claims nothing more"
        await w.over()

    run(scenario())


# ── A held job commits for itself (WORKER-CONTRACT A1, A4, A5, A6) ──


def test_a_stream_that_does_not_name_what_a_commit_awaits_carries_a_workers_claims_and_none_of_its_commits() -> None:
    assert JOB_COMMIT_CHANNELS == ("mark:commit-ok", "mark:commit-failed", "browse:annotation-result", "browse:annotation-failed")

    async def scenario() -> None:
        # A worker that never commits names nothing more, and claims as any other.
        w = World(channels=JOB_CLAIM_CHANNELS)
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            with pytest.raises(BusRequestError) as refused:
                await job.commit(RESOURCE, [made("ann-1")])
            assert refused.value.code == "bus.unsubscribed"
            assert w.sent("mark:commit") == []
            await job.fail("its stream names no reply to a commit")
        assert "durability" not in w.sent("job:fail")[0]
        await w.over()

    run(scenario())


def test_a_commit_cites_the_job_and_is_established_when_the_record_acknowledges_it_and_not_before() -> None:
    async def scenario() -> None:
        # The acknowledgement takes half a minute to arrive: inside the commit's wait, which is the table's.
        w = World(wire=[Deliver(), Delay(30_000), Deliver()])
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            before = claims.vitals()
            # A job commits on more than one resource: here, on one that is not its own.
            committing = asyncio.ensure_future(job.commit(ResourceId("res-new"), [made("ann-1"), made("ann-2")]))
            await pass_time(29.0)
            assert w.sent("mark:commit") == [
                {"resourceId": "res-new", "annotations": [annotation("ann-1"), annotation("ann-2")], "jobId": "job-1"}
            ]
            (commit,) = w.requested("mark:commit")
            assert commit.correlation_id is not None, "a request, answered at its correlation id"
            assert not committing.done(), "the gateway taking the message says nothing of the record"

            await pass_time(2.0)
            await soon(committing)
            assert w.sent("browse:annotation-requested") == [], "nothing is asked of a commit the record acknowledged"
            assert w.said() == [], "a commit is no lifecycle message"
            assert claims.vitals() == before, "and no activity"

            # Nor is it the job's first message: that is still to be said.
            await job.start()
            await finish(job)
        assert w.sent("job:complete") == [
            {
                "resourceId": "res-1",
                "jobId": "job-1",
                "jobType": "mark",
                "attempt": 1,
                "result": {"found": 0, "persisted": 0},
                "durability": "acknowledged",
            }
        ]
        await w.over()

    run(scenario())


def test_a_batch_of_no_annotations_is_no_commit_and_a_job_that_committed_nothing_states_nothing_of_its_commits() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.extend([running("job-1"), running("job-2")])
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            await job.commit(RESOURCE, [])
            assert w.requested("mark:commit") == []
            await finish(job)
            await (await held(claims)).fail("the model timed out")

        identity: JsonObject = {"resourceId": "res-1", "jobType": "mark", "attempt": 1}
        assert w.sent("job:complete") == [{**identity, "jobId": "job-1", "result": {"found": 0, "persisted": 0}}]
        assert w.sent("job:fail") == [{**identity, "jobId": "job-2", "error": "the model timed out", "willRetry": True}]
        await w.over()

    run(scenario())


def test_a_commit_the_record_refuses_raises_the_records_reason_and_nothing_is_asked_or_observed() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(running("job-1"))
        w.refusing_commits = True
        async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
            job = await held(claims)
            with pytest.raises(BusRequestError) as refused:
                await soon(job.commit(RESOURCE, [made("ann-1")]))
            assert (refused.value.code, refused.value.message) == ("bus.rejected", "the record could not append")
            await pass_time(1.0, step=0.25)
            assert w.requested("browse:annotation-requested") == [], "the record has answered"
            await job.fail("the record could not append")

        assert w.sent("job:fail") == [
            {
                "resourceId": "res-1",
                "jobId": "job-1",
                "jobType": "mark",
                "attempt": 1,
                "error": "the record could not append",
                "willRetry": True,
            }
        ]
        await w.over()

    run(scenario())


def test_a_commit_nobody_acknowledges_asks_whether_the_batchs_last_annotation_is_on_the_resource_and_is_established_when_it_is() -> None:
    async def scenario() -> None:
        w = World(wire=wire_for("probe-confirmed"))
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
            job = await held(claims)
            await hurried(job.commit(ResourceId("res-new"), [made("ann-1"), made("ann-2")]))

            # The last, on the resource the batch was for.
            assert w.sent("browse:annotation-requested") == [{"resourceId": "res-new", "annotationId": "ann-2"}]
            (question,) = w.requested("browse:annotation-requested")
            assert question.correlation_id is not None
            assert len(w.requested("mark:commit")) == 1, "the record is asked what it holds; the batch is not sent again"
            await finish(job)

        assert w.sent("job:complete")[0]["durability"] == "probe-confirmed"
        await w.over()

    run(scenario())


def test_answered_that_it_is_not_there_the_commit_raises_what_its_unanswered_request_did_and_the_failure_says_what_was_observed() -> None:
    async def scenario() -> None:
        w = World(wire=wire_for("probe-refused"))
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
            job = await held(claims)
            failed = await commit_observing(w, job, "probe-refused")

            # The failure of the `mark:commit` request itself, and not one made
            # of it, nor the question's: that one carries what the record answered.
            assert failed is not None
            assert (failed.code, failed.message) == ("bus.timeout", f"Bus request timed out after {QUICK}ms on mark:commit-ok")
            assert failed.failure is None
            assert len(w.requested("browse:annotation-requested")) == 1
            await job.fail("the commit was not established")

        assert w.sent("job:fail") == [
            {
                "resourceId": "res-1",
                "jobId": "job-1",
                "jobType": "mark",
                "attempt": 1,
                "error": "the commit was not established",
                "willRetry": True,
                "durability": "probe-refused",
            }
        ]
        await w.over()

    run(scenario())


def test_not_answered_the_commit_waits_as_long_again_raises_the_same_and_the_failure_says_that_nobody_answered() -> None:
    async def scenario() -> None:
        w = World(wire=wire_for("probe-unreachable"))
        w.offered.append(running("job-1"))
        # Each wait is the table's: for the acknowledgement, and then for the answer.
        wait = MARK_COMMIT_TIMEOUT_MS / 1000
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            committing = asyncio.ensure_future(job.commit(RESOURCE, [made("ann-1")]))
            await pass_time(wait - 1)
            assert w.requested("browse:annotation-requested") == [], "nothing is asked while the acknowledgement may still come"
            await pass_time(2)
            assert len(w.requested("browse:annotation-requested")) == 1
            await pass_time(wait - 2)
            assert not committing.done(), "the answer is waited for as long again"
            await pass_time(2)
            with pytest.raises(BusRequestError) as failed:
                await soon(committing)
            assert (failed.value.code, failed.value.message) == (
                "bus.timeout",
                f"Bus request timed out after {MARK_COMMIT_TIMEOUT_MS}ms on mark:commit-ok",
            )
            assert len(w.requested("browse:annotation-requested")) == 1
            await job.fail("the commit was not established")

        assert w.sent("job:fail")[0]["durability"] == "probe-unreachable"
        await w.over()

    run(scenario())


# What establishes a commit is that the record answered, and not what this SDK
# makes of the answer: neither reply is read.
def test_an_acknowledgement_this_sdk_cannot_type_establishes_the_commit_all_the_same() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(running("job-1"))
        w.transport.queue_reply("mark:commit", [{"stored": "every one of them"}])
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            await soon(job.commit(RESOURCE, [made("ann-1")]))
            assert w.requested("browse:annotation-requested") == [], "the record has answered"
            await finish(job)

        assert w.sent("job:complete")[0]["durability"] == "acknowledged"
        await w.over()

    run(scenario())


def test_an_answer_this_sdk_cannot_type_establishes_the_commit_all_the_same() -> None:
    async def scenario() -> None:
        w = World(wire=wire_for("probe-confirmed"))
        w.offered.append(running("job-1"))
        w.transport.queue_reply("browse:annotation-requested", [{"held": True}])
        async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
            job = await held(claims)
            await hurried(job.commit(RESOURCE, [made("ann-1")]))
            assert len(w.requested("browse:annotation-requested")) == 1
            await finish(job)

        assert w.sent("job:complete")[0]["durability"] == "probe-confirmed"
        await w.over()

    run(scenario())


# The question's failure is read by the code it carries: `bus.rejected` is the
# record's answer that is not the annotation, and nothing else is an answer.
def test_a_question_that_fails_under_any_code_but_the_records_refusal_is_one_nobody_answered() -> None:
    async def observed(w: World) -> JsonValue:
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
            job = await held(claims)
            with pytest.raises(BusRequestError) as failed:
                await hurried(job.commit(RESOURCE, [made("ann-1")]))
            # The commit's own failure, never the question's.
            assert (failed.value.code, failed.value.message) == ("bus.timeout", f"Bus request timed out after {QUICK}ms on mark:commit-ok")
            await job.fail("the commit was not established")
        await w.over()
        return w.sent("job:fail")[0]["durability"]

    async def scenario() -> None:
        # The gateway did not take the question.
        assert await observed(World(wire=[Deliver(), DropReply(), RejectEmit(), Deliver()])) == "probe-unreachable"

        # The gateway answered for a record it could not reach.
        unreachable = World(wire=wire_for("probe-refused"))
        unreachable.asked_of["ann-1"] = {"message": "the record is not answering", "code": "peer-unavailable"}
        assert await observed(unreachable) == "probe-unreachable"

        # The stream names the commit's replies, and not the question's.
        unnamed = (*JOB_CLAIM_CHANNELS, "mark:commit-ok", "mark:commit-failed")
        assert await observed(World(channels=unnamed, wire=[Deliver(), DropReply(), Deliver()])) == "probe-unreachable"

    run(scenario())


def test_any_other_failure_of_the_commits_request_is_raised_as_it_is_and_nothing_is_asked_or_observed() -> None:
    async def scenario() -> None:
        w = World(wire=[Deliver(), RejectEmit(), Deliver()])
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
            job = await held(claims)
            with pytest.raises(TransportError, match="emit rejected by schedule on mark:commit"):
                await soon(job.commit(RESOURCE, [made("ann-1")]))
            await pass_time(1.0, step=0.25)
            assert w.requested("browse:annotation-requested") == []
            await job.fail("the gateway did not take the commit")

        assert "durability" not in w.sent("job:fail")[0]
        await w.over()

    run(scenario())


def test_a_settled_job_commits_nothing() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            await finish(job)
            with pytest.raises(RuntimeError, match="already settled"):
                await job.commit(RESOURCE, [made("ann-1")])
            assert w.requested("mark:commit") == []
        await w.over()

    run(scenario())


# WORKER-CONTRACT A6. The job remembers the weakest of what its commits
# observed: acknowledged, then established by asking, then not established.
# The two ways of not being established are equally weak, and the first seen
# is kept.
ESTABLISHED: Final[list[tuple[list[DurabilityEvidence], DurabilityEvidence]]] = [
    (["acknowledged"], "acknowledged"),
    (["acknowledged", "acknowledged"], "acknowledged"),
    (["probe-confirmed"], "probe-confirmed"),
    (["acknowledged", "probe-confirmed"], "probe-confirmed"),
    (["probe-confirmed", "acknowledged"], "probe-confirmed"),
    (["acknowledged", "probe-confirmed", "acknowledged"], "probe-confirmed"),
]
NOT_ESTABLISHED: Final[list[tuple[list[DurabilityEvidence], DurabilityEvidence]]] = [
    (["probe-refused"], "probe-refused"),
    (["probe-unreachable"], "probe-unreachable"),
    (["acknowledged", "probe-refused"], "probe-refused"),
    (["probe-confirmed", "probe-unreachable"], "probe-unreachable"),
    (["probe-refused", "acknowledged"], "probe-refused"),
    (["probe-unreachable", "probe-confirmed"], "probe-unreachable"),
    (["probe-refused", "probe-unreachable"], "probe-refused"),
    (["probe-unreachable", "probe-refused"], "probe-unreachable"),
]


def test_a_completion_says_the_weakest_of_what_the_jobs_commits_observed() -> None:
    async def scenario() -> None:
        for observed, weakest in (*ESTABLISHED, *NOT_ESTABLISHED):
            async with having_committed(*observed) as (w, job):
                await finish(job)
            assert [said["durability"] for said in w.sent("job:complete")] == [weakest], observed

    run(scenario())


def test_a_failure_says_what_a_commit_that_was_not_established_observed_and_nothing_of_commits_that_all_were() -> None:
    async def scenario() -> None:
        for observed, weakest in NOT_ESTABLISHED:
            async with having_committed(*observed) as (w, job):
                await job.fail("the commit was not established")
            assert [said["durability"] for said in w.sent("job:fail")] == [weakest], observed

        for observed, _ in ESTABLISHED:
            async with having_committed(*observed) as (w, job):
                await job.fail("the model timed out")
            (said,) = w.sent("job:fail")
            assert "durability" not in said, observed

    run(scenario())


def test_a_cancel_says_nothing_of_the_jobs_commits_and_a_job_failed_for_its_worker_says_what_an_unestablished_one_observed() -> None:
    async def scenario() -> None:
        async with having_committed("probe-refused") as (w, job):
            await job.cancel()
        assert w.sent("job:cancel") == [{"resourceId": "res-1", "jobId": "job-1", "jobType": "mark"}]

        async with having_committed("probe-unreachable") as (w, job):
            pass  # The worker stops while it holds the job.
        (stopped,) = w.sent("job:fail")
        assert (stopped["error"], stopped["durability"]) == ("The worker stopped while it held the job", "probe-unreachable")

        async with having_committed("probe-refused") as (w, job), job:
            pass  # Held, and left without being settled.
        (left,) = w.sent("job:fail")
        assert (left["error"], left["durability"]) == ("The worker let go of the job without settling it", "probe-refused")

    run(scenario())


def test_a_yield_job_commits_and_says_how_its_commits_were_established_as_a_mark_job_does() -> None:
    async def scenario() -> None:
        w = World(wire=wire_for("probe-confirmed"))
        w.offered.append(running("job-1", "yield"))
        async with w.client.job.claim(EVERYTHING, mark_commit_timeout_ms=QUICK) as claims:
            job = await held(claims)
            assert isinstance(job, HeldYieldJob)
            assert await commit_observing(w, job, "probe-confirmed") is None
            await job.complete(JobGenerationResult(resource_id=job.resource_id, resource_name="Ouranos", truncated=False))

        assert w.sent("mark:commit")[0]["jobId"] == "job-1"
        assert w.sent("job:complete")[0]["durability"] == "probe-confirmed"
        await w.over()

    run(scenario())


def test_vitals_say_what_the_worker_holds_and_has_done_and_a_silent_held_job_is_stalled() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING, held_job_stall_ms=400, held_job_stall_check_ms=100) as claims:
            empty = claims.vitals()
            assert (empty.last_claim_at, empty.active_job, empty.jobs_completed) == (None, None, 0)

            job = await held(claims)
            holding = claims.vitals()
            assert holding.active_job is not None
            assert (holding.active_job.job_id, holding.active_job.since) == ("job-1", holding.last_claim_at)
            w.relay("job:queued", queued("highlighting"))
            await turns()
            assert claims.vitals().last_queued_event_at is not None

            # It reports for a second, well past the threshold, and is never stalled.
            for step in range(10):
                await pass_time(0.1, step=0.1)
                await job.progress(JobProgress(percentage=step))
            assert now(claims.stalled) is None, "however long it runs"

            await pass_time(0.6, step=0.1)
            stall = now(claims.stalled)
            assert stall is not None
            assert (stall.job_id, stall.threshold_ms) == ("job-1", 400)
            assert stall.silent_for_ms > 400

            await finish(job)
            done = claims.vitals()
            assert (done.active_job, done.jobs_completed) == (None, 1)
            assert done.last_finished_at is not None
        await w.over()

    run(scenario())


# ── Each job has a trace of its own (WORKER-CONTRACT T1) ────────


def test_a_claim_is_made_in_no_trace_whatever_span_the_job_before_it_was_settled_in() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.extend(running(job_id) for job_id in ("job-1", "job-2", "job-3"))
        async with w.client.job.claim(EVERYTHING) as claims:
            first = await held(claims)
            # A worker's code settles each job inside the span it opened for it.
            with in_span(7):
                await finish(first)
            second = await held(claims)
            with in_span(8):
                await second.fail("kaboom")
            third = await held(claims)
            with in_span(9):
                await third.cancel()
            await turns()
            assert w.claimed_in == [None, None, None, None]
        await w.over()

    run(scenario())


def test_the_first_claim_and_one_an_announcement_wakes_are_made_in_no_trace_whatever_span_the_claims_are_first_read_in() -> None:
    async def scenario() -> None:
        w = World()
        async with w.client.job.claim(TAGGING) as claims:
            with in_span(9):
                reading = asyncio.ensure_future(held(claims))
                await turns()
            assert w.claimed_in == [None], "the first claim, answered with nothing pending"

            w.offered.append(running("job-1", params={"motivation": "tagging"}))
            w.relay("job:queued", queued("tagging"))
            await finish(await reading)
            await turns()
            assert w.claimed_in == [None, None, None], "the claim the announcement woke, and the one the settle made"
        await w.over()

    run(scenario())


def test_a_held_job_states_the_trace_its_reply_arrived_in_and_none_when_it_arrived_in_none() -> None:
    async def scenario() -> None:
        # The first claim's own answer is lost on the wire, and the test answers it by hand.
        w = World(wire=[DropReply(), Deliver(), Deliver()])
        arrived_in = TraceContext(traceparent="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate="vendor=value")
        async with w.client.job.claim(EVERYTHING) as claims:
            reading = asyncio.ensure_future(held(claims))
            await turns()
            (claim,) = w.requested("job:claim")
            w.transport.deliver(
                Frame(channel="job:claimed", payload={"response": running("job-1")}, correlation_id=claim.correlation_id, trace=arrived_in)
            )
            first = await reading
            assert first.trace == arrived_in

            w.offered.append(running("job-2"))
            with in_span(7):
                await finish(first)
            second = await held(claims)
            assert second.trace is None, "its reply arrived in no trace: it is not in that of the job settled before it"
            await finish(second)
        await w.over()

    run(scenario())
