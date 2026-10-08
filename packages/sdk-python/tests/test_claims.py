"""`job.claim`: a worker's claims and the jobs it comes to hold.

The rules are docs/protocol/WORKER-CONTRACT.md's, and the worker conformance
suite (tests/conformance/worker) holds them on the wire. These are the same
rules over a transport the test answers by hand: the stand-in dispatcher
below answers each `job:claim` with what a test offered, refused, or with
nothing pending. Two tables are run here too: whether a job matches a filter,
and whether a failed job is retried.
"""

import asyncio
from collections import deque
from typing import Final

import pytest
from aio import pass_time, run, soon, turns
from pydantic import BaseModel, Field, JsonValue, TypeAdapter
from spec import SPEC, JsonObject, objects, read

from semiont.claims import JOB_CLAIM_CHANNELS, ClaimRefusal, Claims, HeldJob, HeldMarkJob, HeldYieldJob, will_retry_after
from semiont.client import SemiontClient
from semiont.errors import BusRequestError
from semiont.job_filter import job_matches_filter
from semiont.testing import FaultyTransport, InMemoryContent, StubGateway
from semiont.transport import Frame
from semiont.types import FailureClass, JobDetectionResult, JobFilter, JobGenerationResult, JobProgress, UnitCursor
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


class World:
    """A client, and a stand-in dispatcher that answers its claims."""

    def __init__(self, *, channels: tuple[str, ...] | None = None) -> None:
        self.offered: Final[deque[JsonObject]] = deque()
        self.refusals: Final[deque[JsonObject]] = deque()
        self.transport: Final = FaultyTransport(make_response=self._answer, channels=channels)
        self.transport.refuse_when(self._refusal)
        self.client: Final = SemiontClient(self.transport, InMemoryContent(), StubGateway())

    def _refusal(self, operation: str, _: object) -> JsonObject | None:
        if operation != "job:claim":
            return None
        if self.refusals:
            return self.refusals.popleft()
        return None if self.offered else {"message": "No pending job matches", "code": "none-pending"}

    def _answer(self, operation: str, _: object) -> JsonValue:
        assert operation == "job:claim", f"nothing is scripted to answer {operation}"
        return self.offered.popleft()

    def relay(self, channel: str, payload: JsonObject) -> None:
        """A broadcast the gateway relays to this worker."""
        self.transport.deliver(Frame(channel=channel, payload=payload))

    def sent(self, channel: str) -> list[JsonObject]:
        return [dict(frame.payload) for frame in self.transport.emitted if frame.channel == channel]

    def said(self) -> list[tuple[str, JsonObject]]:
        """Everything said that is not a claim: the lifecycle, in order. Each is global, and nobody's reply."""
        said: list[tuple[str, JsonObject]] = []
        for frame in self.transport.emitted:
            if frame.channel != "job:claim":
                assert (frame.scope, frame.correlation_id) == (None, None), frame.channel
                said.append((frame.channel, dict(frame.payload)))
        return said

    async def over(self) -> None:
        await self.client.close()
        await self.transport.close()


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
            await job.complete(JobDetectionResult(found=9, persisted=7), durability="acknowledged")
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
                running("job-2", metadata={"retryCount": 0, "maxRetries": 1}),
                running("job-3", metadata={"retryCount": 1, "maxRetries": 1}),
                running("job-4"),
            ]
        )
        async with w.client.job.claim(EVERYTHING) as claims:
            await (await held(claims)).fail("the model timed out", completed_units=["Person"])
            await (await held(claims)).fail("the resource has no text", failure_class="deterministic", durability="probe-refused")
            await (await held(claims)).fail("the model timed out")
            await (await held(claims)).cancel(["Person"])

        base: JsonObject = {"resourceId": "res-1", "jobType": "mark"}
        assert w.sent("job:fail") == [
            # A class the worker does not know is not stated.
            {**base, "jobId": "job-1", "attempt": 1, "error": "the model timed out", "completedUnits": ["Person"], "willRetry": True},
            {
                **base,
                "jobId": "job-2",
                "attempt": 1,
                "error": "the resource has no text",
                "failureClass": "deterministic",
                "willRetry": False,
                "durability": "probe-refused",
            },
            {**base, "jobId": "job-3", "attempt": 2, "error": "the model timed out", "willRetry": False},
        ]
        assert w.sent("job:cancel") == [{**base, "jobId": "job-4", "completedUnits": ["Person"]}]
        await w.over()

    run(scenario())


def test_a_cancellation_that_names_the_held_job_is_signalled_and_any_other_is_not() -> None:
    async def scenario() -> None:
        w = World()
        w.offered.append(running("job-1"))
        async with w.client.job.claim(EVERYTHING) as claims:
            job = await held(claims)
            w.relay("job:cancel-requested", {"jobId": "job-7"})
            w.relay("job:cancel-requested", {"jobType": "mark"})
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
