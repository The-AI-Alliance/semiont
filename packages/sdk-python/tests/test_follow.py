"""Following a job (`docs/protocol/JOBS.md` § Following a job).

Through the two methods that create one: `mark.delegate` and `yield_.delegate`.
"""

import asyncio
from typing import assert_never

import pytest
from aio import pass_time, run, soon, turns
from kb import refusing, silent
from pydantic import JsonValue, TypeAdapter, ValidationError
from spec import JsonObject

from semiont.client import ClientTiming, SemiontClient
from semiont.errors import BusRequestError, JobError, SemiontError, TransportError
from semiont.identifiers import ResourceId
from semiont.namespaces.follow import Delegation, JobAttemptFailed, JobCompleted, JobEvent, JobProgressed
from semiont.namespaces.yield_ import generation_stall_deadline_ms
from semiont.running import Running
from semiont.testing import FaultyTransport, InMemoryContent, StubGateway
from semiont.timing import GENERATION_STALL_FLOOR_MS, JOB_SILENCE_MS, JOB_STATUS_POLL_MS
from semiont.transport import Frame
from semiont.types import (
    CommentingJobParams,
    GatheredContext,
    GenerationJobParams,
    HighlightingJobParams,
    JobCompleteCommand,
    JobDeclinedResult,
    JobDetectionResult,
    JobGenerationResult,
    JobProgress,
    JobType,
    MarkJobCompleteCommand,
    MarkJobParams,
    YieldJobCompleteCommand,
)

SILENCE, POLL = JOB_SILENCE_MS / 1000, JOB_STATUS_POLL_MS / 1000
RESOURCE = ResourceId("res-1")
CONTEXT: JsonObject = {
    "focus": {
        "kind": "resource",
        "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []},
    },
    "graph": {"nodes": [], "edges": []},
    "metadata": {},
}

type Client = SemiontClient[FaultyTransport]


def world(*, answered: bool = True) -> tuple[Client, FaultyTransport]:
    """A client whose `job:create` is answered with `job-1`, or by the test when it is not `answered`."""
    transport = FaultyTransport() if answered else silent()
    if answered:
        transport.queue_reply("job:create", [{"jobId": "job-1"}])
    return SemiontClient(transport, InMemoryContent(), StubGateway()), transport


def highlighting(client: Client) -> Delegation[MarkJobCompleteCommand]:
    return client.mark.delegate(RESOURCE, HighlightingJobParams(motivation="highlighting"))


def generation(client: Client, *, stall_deadline_ms: int | None, max_tokens: int | None = None) -> Delegation[YieldJobCompleteCommand]:
    stated: JsonObject = {"title": "A summary", "storageUri": "file://a-summary.md", "context": CONTEXT}
    if max_tokens is not None:
        stated["maxTokens"] = max_tokens
    return client.yield_.delegate(GenerationJobParams.model_validate(stated), stall_deadline_ms=stall_deadline_ms)


def say(client: Client, channel: str, job_id: str, of: JobType = "mark", /, **more: JsonValue) -> None:
    """A frame of the lifecycle of the job `job_id`, which is `of` that type."""
    client.bus.emit(channel, {"resourceId": "res-1", "jobId": job_id, "jobType": of, **more})


def progress(percentage: float) -> JsonObject:
    return {"percentage": percentage, "progress": {"percentage": percentage}}


def status(of: str, **more: JsonValue) -> JsonObject:
    return {
        "jobId": "job-1",
        "type": "mark",
        "status": of,
        "userId": "did:web:example.org:users:alice",
        "created": "2026-10-01T00:00:00.000Z",
        **more,
    }


def asked(transport: FaultyTransport, channel: str) -> list[Frame]:
    return [frame for frame in transport.emitted if frame.channel == channel]


def kind[C: JobCompleteCommand](event: JobEvent[C]) -> str:
    match event:
        case JobProgressed(data=data):
            return f"progress {data.percentage:g}"
        case JobAttemptFailed():
            return "failed"
        case JobCompleted():
            return "complete"
        case _:
            assert_never(event)


async def collected[C: JobCompleteCommand](delegation: Delegation[C], seen: list[JobEvent[C]]) -> list[str]:
    """Everything a follower gives, as words: each event's kind, and the code of the failure that ended it."""
    kinds: list[str] = []
    try:
        async for event in delegation:
            seen.append(event)
            kinds.append(kind(event))
    except SemiontError as error:
        kinds.append(f"error {error.code}")
    return kinds


def following[C: JobCompleteCommand](delegation: Delegation[C]) -> tuple[asyncio.Task[list[str]], list[JobEvent[C]]]:
    seen: list[JobEvent[C]] = []
    return asyncio.ensure_future(collected(delegation, seen)), seen


def test_a_job_reports_its_progress_and_ends_with_its_completion() -> None:
    async def scenario() -> None:
        client, transport = world()
        task, seen = following(highlighting(client))
        await turns()
        assert [(frame.channel, dict(frame.payload)) for frame in transport.emitted] == [
            ("job:create", {"jobType": "mark", "resourceId": "res-1", "params": {"motivation": "highlighting"}})
        ]
        say(client, "job:report-progress", "job-1", **progress(10))
        # Another job's frames are not this follower's.
        say(client, "job:report-progress", "job-2", **progress(99))
        say(client, "job:complete", "job-2")
        say(client, "job:report-progress", "job-1", **progress(60))
        # Progress that states nothing of how far the job is, reports nothing.
        say(client, "job:report-progress", "job-1", percentage=70)
        say(client, "job:complete", "job-1", result={"found": 3, "persisted": 2, "errors": 1})
        assert await soon(task) == ["progress 10", "progress 60", "complete"]
        # Its completion is the last of its events.
        last = seen[-1]
        assert isinstance(last, JobCompleted)
        assert (last.kind, last.data.job_id, last.data.resource_id) == ("complete", "job-1", "res-1")
        assert last.data.result == JobDetectionResult(found=3, persisted=2, errors=1)
        assert asked(transport, "job:status-requested") == []
        await client.close()

    run(scenario())


def test_awaited_a_job_gives_its_completion() -> None:
    async def scenario() -> None:
        client, _ = world()
        awaiting = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        say(client, "job:report-progress", "job-1", **progress(10))
        say(client, "job:complete", "job-1", result={"found": 2, "persisted": 2})
        done = await soon(awaiting)
        # The completion itself, and no event to take it out of: a `mark` job's, whose result is what a `mark` job reports.
        assert type(done) is MarkJobCompleteCommand
        assert (done.job_id, done.job_type, done.resource_id) == ("job-1", "mark", "res-1")
        assert done.result == JobDetectionResult(found=2, persisted=2)
        await client.close()

    run(scenario())


async def _awaited[C: JobCompleteCommand](delegation: Delegation[C]) -> C:
    return await delegation


def counted(done: MarkJobCompleteCommand) -> int | None:
    """What a `mark` job found. What it reports is its counts, a decline, or nothing: a type checker holds this to naming all three."""
    match done.result:
        case JobDetectionResult(found=found):
            return found
        case JobDeclinedResult() | None:
            return None
        case _ as other:
            assert_never(other)


def test_what_a_mark_job_reports_is_its_counts_or_a_decline() -> None:
    async def scenario(result: JsonObject) -> MarkJobCompleteCommand:
        client, _ = world()
        awaiting = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        say(client, "job:complete", "job-1", result=result)
        done = await soon(awaiting)
        await client.close()
        return done

    assert counted(run(scenario({"found": 4, "persisted": 3}))) == 4
    declined = run(scenario({"declined": True, "reason": "encrypted"}))
    assert isinstance(declined.result, JobDeclinedResult)
    assert counted(declined) is None


def test_awaited_a_generation_gives_the_resource_it_made() -> None:
    async def scenario() -> None:
        client, _ = world()
        awaiting = asyncio.ensure_future(_awaited(generation(client, stall_deadline_ms=None)))
        await turns()
        made: JsonObject = {"resourceId": "res-summary", "resourceName": "A summary", "truncated": False}
        say(client, "job:complete", "job-1", "yield", result=made)
        done = await soon(awaiting)
        assert type(done) is YieldJobCompleteCommand
        assert done.job_type == "yield"
        assert done.result == JobGenerationResult(resource_id=ResourceId("res-summary"), resource_name="A summary", truncated=False)
        await client.close()

    run(scenario())


def test_a_delegation_is_awaited_or_read_and_once() -> None:
    async def scenario() -> None:
        client, transport = world()
        read = highlighting(client)
        task, _ = following(read)
        await turns()
        say(client, "job:complete", "job-1")
        assert await soon(task) == ["complete"]
        with pytest.raises(RuntimeError):
            await read
        with pytest.raises(RuntimeError):
            aiter(read)

        transport.queue_reply("job:create", [{"jobId": "job-1"}])
        awaited = highlighting(client)
        awaiting = asyncio.ensure_future(_awaited(awaited))
        await turns()
        with pytest.raises(RuntimeError):
            aiter(awaited)
        say(client, "job:complete", "job-1")
        await soon(awaiting)
        # Each was one job, created once.
        assert len(asked(transport, "job:create")) == 2
        await client.close()

    run(scenario())


def test_a_follower_that_ends_on_anything_but_a_completion_is_no_completion() -> None:
    async def scenario() -> None:
        async def ended_early() -> JobEvent[MarkJobCompleteCommand]:
            return JobProgressed(JobProgress(percentage=50))

        with pytest.raises(RuntimeError, match="ended on a progress event, not on its completion"):
            await Delegation(Running(lambda _: asyncio.ensure_future(ended_early())))

    run(scenario())


def test_nothing_is_sent_until_a_delegation_is_awaited_or_read() -> None:
    async def scenario() -> None:
        client, transport = world()
        highlighting(client)
        await turns()
        assert transport.emitted == []
        await client.close()

    run(scenario())


def test_frames_that_arrive_before_the_jobs_id_is_known_are_kept_and_handled_in_the_order_they_came() -> None:
    async def scenario() -> None:
        client, transport = world(answered=False)
        task, _ = following(highlighting(client))
        await turns()
        created = asked(transport, "job:create")[0]
        say(client, "job:report-progress", "job-1", **progress(10))
        say(client, "job:report-progress", "job-2", **progress(99))
        say(client, "job:complete", "job-1")
        await turns()
        assert not task.done()
        transport.deliver(Frame(channel="job:created", payload={"response": {"jobId": "job-1"}}, correlation_id=created.correlation_id))
        assert await soon(task) == ["progress 10", "complete"]
        await client.close()

    run(scenario())


def test_a_silent_job_is_asked_for_its_status_until_its_status_is_an_end() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:status-requested", [status("running"), status("complete")])
        task, seen = following(highlighting(client))
        await turns()

        await pass_time(SILENCE - 0.1, step=0.1)
        assert asked(transport, "job:status-requested") == []
        await pass_time(0.2, step=0.1)
        assert [dict(frame.payload) for frame in asked(transport, "job:status-requested")] == [{"jobId": "job-1"}]
        # The second ask comes a poll after the first, and not before.
        await pass_time(POLL - 0.3, step=0.1)
        assert len(asked(transport, "job:status-requested")) == 1
        assert not task.done()
        await pass_time(0.4, step=0.1)
        assert await soon(task) == ["complete"]
        assert len(asked(transport, "job:status-requested")) == 2

        # What the stream did not carry, from the status: which says what the job was, and the follower knows what it was about.
        done = seen[0]
        assert isinstance(done, JobCompleted)
        assert (done.data.job_id, done.data.resource_id, done.data.job_type, done.data.result) == ("job-1", "res-1", "mark", None)
        await client.close()

    run(scenario())


def test_a_status_carries_the_result_its_job_was_stored_with_and_an_empty_one_is_none() -> None:
    async def scenario(result: JsonValue) -> JobEvent[MarkJobCompleteCommand]:
        client, transport = world()
        transport.queue_reply("job:status-requested", [status("complete", result=result)])
        task, seen = following(highlighting(client))
        await turns()
        await pass_time(SILENCE + 0.1, step=0.5)
        assert await soon(task) == ["complete"]
        await client.close()
        return seen[0]

    stored = run(scenario({"found": 3, "persisted": 2}))
    assert isinstance(stored, JobCompleted)
    assert stored.data.result == JobDetectionResult(found=3, persisted=2)
    empty = run(scenario({}))
    assert isinstance(empty, JobCompleted)
    assert empty.data.result is None


GENERATED: JsonObject = {"resourceId": "res-summary", "resourceName": "A summary", "truncated": False}


def test_a_completion_heard_that_is_another_verb_s_ends_the_follower_and_is_no_failure_of_the_job() -> None:
    async def scenario() -> None:
        client, transport = world()
        awaiting = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        # The job that was delegated is a `mark` job, and this says a `yield` job completed.
        say(client, "job:complete", "job-1", "yield", result=GENERATED)
        with pytest.raises(TransportError, match="is a yield job's, and the job delegated is a mark job") as ended:
            await soon(awaiting)
        assert ended.value.code == "error"
        assert asked(transport, "job:cancel-requested") == []
        await client.close()

    run(scenario())


@pytest.mark.parametrize(
    ("delegated", "said"),
    [
        ("mark", {"type": "yield"}),
        ("mark", {"type": "yield", "result": GENERATED}),
        ("mark", {"result": GENERATED}),
        ("yield", {"type": "mark"}),
        ("yield", {"type": "yield", "result": {"found": 3, "persisted": 2}}),
    ],
    ids=[
        "a mark job, and the status is a yield job's",
        "a mark job, and the status is a yield job's with its result",
        "a mark job, and the result is a generation's",
        "a yield job, and the status is a mark job's",
        "a yield job, and the result is a mark job's counts",
    ],
)
def test_a_status_whose_completion_is_not_the_verb_s_ends_the_follower_and_is_no_failure_of_the_job(
    delegated: JobType, said: JsonObject
) -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:status-requested", [status("complete", **said)])
        task = following(highlighting(client))[0] if delegated == "mark" else following(generation(client, stall_deadline_ms=None))[0]
        await turns()
        await pass_time(SILENCE + 0.1, step=0.5)
        # What the knowledge base answered is not the protocol's: no completion is made of it, and the job is not said to have failed.
        assert await soon(task) == ["error error"]
        await client.close()

    run(scenario())


def test_a_status_whose_completion_is_not_the_verb_s_is_told_as_what_it_is() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:status-requested", [status("complete", result=GENERATED)])
        awaiting = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        await pass_time(SILENCE + 0.1, step=0.5)
        with pytest.raises(TransportError, match="The status of job job-1 is not a completed mark job's") as ended:
            await soon(awaiting)
        assert ended.value.code == "error"
        await client.close()

    run(scenario())


def test_every_frame_of_the_job_starts_the_silence_again() -> None:
    async def scenario() -> None:
        client, transport = world()
        task, _ = following(highlighting(client))
        await turns()
        await pass_time(SILENCE - 1, step=0.5)
        say(client, "job:report-progress", "job-1", **progress(10))
        await pass_time(SILENCE - 1, step=0.5)
        assert asked(transport, "job:status-requested") == []
        await pass_time(2, step=0.5)
        assert len(asked(transport, "job:status-requested")) == 1
        # A status that could not be had is asked for again at the next poll.
        await pass_time(POLL + 0.5, step=0.5)
        assert len(asked(transport, "job:status-requested")) == 2
        assert not task.done()
        await client.close()
        assert await soon(task) == ["progress 10", "error bus.closed"]

    run(scenario())


@pytest.mark.parametrize(
    ("of", "more", "code", "message"),
    [
        ("failed", {"error": "the worker gave up"}, "job.failed", "the worker gave up"),
        ("failed", {}, "job.failed", "Job failed"),
        # Nothing announces a cancellation: this is where its follower learns of one.
        ("cancelled", {}, "job.cancelled", "The job was cancelled"),
    ],
    ids=["failed", "failed, with no word why", "cancelled"],
)
def test_a_status_that_is_an_end_and_no_completion_ends_the_follower_with_it(of: str, more: JsonObject, code: str, message: str) -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:status-requested", [status(of, **more)])
        failed = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        await pass_time(SILENCE + 0.1, step=0.5)
        with pytest.raises(JobError) as ended:
            await soon(failed)
        assert (ended.value.code, ended.value.message, ended.value.job_id) == (code, message, "job-1")
        await client.close()

    run(scenario())


def test_a_failure_the_queue_will_retry_is_reported_and_followed_past() -> None:
    async def scenario() -> None:
        client, transport = world()
        task, seen = following(highlighting(client))
        await turns()
        say(client, "job:fail", "job-1", error="a blip", willRetry=True)
        # The attempt that died is not asked about, however long the next takes.
        await pass_time(SILENCE * 3, step=1)
        assert asked(transport, "job:status-requested") == []
        say(client, "job:report-progress", "job-1", **progress(60))
        say(client, "job:complete", "job-1")
        assert await soon(task) == ["failed", "progress 60", "complete"]
        setback = seen[0]
        assert isinstance(setback, JobAttemptFailed)
        assert (setback.kind, setback.data.error) == ("failed", "a blip")
        await client.close()

    run(scenario())


@pytest.mark.parametrize("said", [{"willRetry": False}, {}], ids=["it says it will not be tried again", "it does not say"])
def test_a_failure_that_is_final_ends_the_follower_and_one_that_does_not_say_is_final(said: JsonObject) -> None:
    async def scenario() -> None:
        client, _ = world()
        failed = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        say(client, "job:fail", "job-1", error="the budget is spent", **said)
        with pytest.raises(JobError, match="the budget is spent") as ended:
            await soon(failed)
        assert (ended.value.code, ended.value.job_id) == ("job.failed", "job-1")
        await client.close()

    run(scenario())


_PARAMS = TypeAdapter[MarkJobParams](MarkJobParams)


@pytest.mark.parametrize(
    "params",
    [
        {"motivation": "tagging", "categories": ["claim"]},
        {"motivation": "tagging", "schemaId": "", "categories": ["claim"]},
        {"motivation": "tagging", "schemaId": "s1"},
        {"motivation": "tagging", "schemaId": "s1", "categories": []},
        {"motivation": "linking"},
        {"motivation": "linking", "entityTypes": []},
        {"motivation": "highlighting", "tone": "scholarly"},
        {"motivation": "commenting", "tone": "critical"},
        {"motivation": "applauding"},
        {},
    ],
    ids=[
        "tagging, no schema",
        "tagging, an empty schema",
        "tagging, no categories",
        "tagging, empty categories",
        "linking, no types",
        "linking, empty types",
        "a parameter its motivation does not take",
        "a tone that is another motivation's",
        "a motivation the vocabulary lacks",
        "no motivation",
    ],
)
def test_a_job_its_worker_could_not_run_cannot_be_described(params: JsonObject) -> None:
    # Nothing here refuses it by hand: the parameters of each motivation are the spec's own shapes, and those say what a job needs.
    with pytest.raises(ValidationError):
        _PARAMS.validate_python(params)


def test_an_option_of_a_job_given_as_nothing_is_not_sent() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:create", [{"jobId": "job-2"}])
        commenting = asyncio.ensure_future(
            _awaited(client.mark.delegate(RESOURCE, CommentingJobParams(motivation="commenting", tone=None, density=1.5, language=None)))
        )
        # What the context holds deeper is sent as it came: a null that came is a null that goes.
        described: JsonObject = {
            "@context": "https://schema.org",
            "@id": "res-1",
            "name": "A resource",
            "description": None,
            "representations": [],
        }
        came: JsonObject = {**CONTEXT, "focus": {"kind": "resource", "resource": described}}
        params = GenerationJobParams(
            title="A summary", storage_uri="file://a-summary.md", context=GatheredContext.model_validate(came), prompt=None, max_tokens=None
        )
        generating = asyncio.ensure_future(_awaited(client.yield_.delegate(params)))
        await turns()
        assert [dict(frame.payload) for frame in asked(transport, "job:create")] == [
            {"jobType": "mark", "resourceId": "res-1", "params": {"motivation": "commenting", "density": 1.5}},
            {"jobType": "yield", "params": {"title": "A summary", "storageUri": "file://a-summary.md", "context": came}},
        ]
        say(client, "job:complete", "job-1")
        say(client, "job:complete", "job-2", "yield")
        await soon(asyncio.gather(commenting, generating))
        await client.close()

    run(scenario())


def test_a_job_whose_creation_is_refused_is_its_followers_failure() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.refuse_when(refusing("job:create"))
        with pytest.raises(BusRequestError) as refused:
            await soon(highlighting(client))
        assert refused.value.code == "bus.rejected"
        await client.close()

    run(scenario())


# ── A generation, which may stall ───────────────────────────────────────


def test_a_generation_that_says_nothing_is_cancelled_and_given_up_on() -> None:
    async def scenario() -> None:
        client, transport = world()
        # Its status says it is running for as long as it is asked: only the deadline ends it.
        transport.queue_reply("job:status-requested", [status("running")] * 50)
        stalled = asyncio.ensure_future(_awaited(generation(client, stall_deadline_ms=30_000)))
        await turns()
        assert [(frame.channel, sorted(frame.payload)) for frame in transport.emitted] == [("job:create", ["jobType", "params"])]

        await pass_time(29.5, step=0.5)
        assert not stalled.done()
        assert asked(transport, "job:cancel-requested") == []
        await pass_time(1, step=0.5)
        with pytest.raises(JobError) as ended:
            await soon(stalled)
        assert (ended.value.code, ended.value.job_id) == ("job.stalled", "job-1")
        assert ended.value.message == "The job stalled: nothing was heard of it within 30000ms"
        # That job and no other: a cancellation by type would end every pending job of it.
        await turns()
        assert [dict(frame.payload) for frame in asked(transport, "job:cancel-requested")] == [{"jobId": "job-1"}]
        await client.close()

    run(scenario())


def test_a_generation_that_stalls_before_its_job_is_known_has_nothing_to_cancel() -> None:
    async def scenario() -> None:
        client, transport = world(answered=False)
        stalled = asyncio.ensure_future(_awaited(generation(client, stall_deadline_ms=5_000)))
        await turns()
        await pass_time(5.5, step=0.5)
        with pytest.raises(JobError) as ended:
            await soon(stalled)
        assert (ended.value.code, ended.value.job_id) == ("job.stalled", None)
        await turns()
        assert asked(transport, "job:cancel-requested") == []
        await client.close()

    run(scenario())


def test_what_a_generation_says_starts_its_stall_deadline_again_and_a_setback_is_followed_past() -> None:
    async def scenario() -> None:
        client, transport = world()
        task, _ = following(generation(client, stall_deadline_ms=30_000))
        await turns()
        await pass_time(25, step=1)
        say(client, "job:report-progress", "job-1", "yield", **progress(10))
        await pass_time(25, step=1)
        # The setback was heard: a deadline left running would cancel the attempt that is coming.
        say(client, "job:fail", "job-1", "yield", error="a blip", willRetry=True)
        await pass_time(25, step=1)
        assert not task.done()
        assert asked(transport, "job:cancel-requested") == []
        say(client, "job:complete", "job-1", "yield")
        assert await soon(task) == ["progress 10", "failed", "complete"]
        await pass_time(60, step=5)
        assert asked(transport, "job:cancel-requested") == []
        await client.close()

    run(scenario())


def test_how_long_a_generation_may_be_silent_grows_with_what_was_asked_of_it() -> None:
    assert generation_stall_deadline_ms(None) == GENERATION_STALL_FLOOR_MS
    assert generation_stall_deadline_ms(100) == GENERATION_STALL_FLOOR_MS
    assert generation_stall_deadline_ms(4000) == 300_000
    assert generation_stall_deadline_ms(4000.4) == 300_030
    assert generation_stall_deadline_ms(-5) == GENERATION_STALL_FLOOR_MS


def test_a_generation_waits_as_long_as_its_length_allows_when_no_deadline_is_stated() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:status-requested", [status("running")] * 100)
        stalled = asyncio.ensure_future(_awaited(generation(client, stall_deadline_ms=None, max_tokens=4000)))
        await turns()
        await pass_time(299, step=1)
        assert not stalled.done()
        await pass_time(2, step=1)
        with pytest.raises(JobError) as ended:
            await soon(stalled)
        assert ended.value.code == "job.stalled"
        await client.close()

    run(scenario())


# ── A client's waits, and its end ───────────────────────────────────────


def test_a_client_told_other_waits_keeps_them() -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        transport.queue_reply("job:create", [{"jobId": "job-1"}])
        transport.queue_reply("job:status-requested", [status("complete")])
        client = SemiontClient(transport, InMemoryContent(), StubGateway(), timing=ClientTiming(job_silence_ms=50, job_status_poll_ms=20))
        assert (client.timing.job_silence_ms, client.timing.bus_request_ms) == (50, 30_000)
        # No clock is moved: a twentieth of a second is waited out.
        done = await soon(highlighting(client))
        assert (done.job_id, done.result) == ("job-1", None)
        await client.close()

    run(scenario())


def test_a_client_that_closes_ends_the_jobs_it_was_following() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.queue_reply("job:create", [{"jobId": "job-2"}])
        task, _ = following(highlighting(client))
        awaited = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        await client.close()
        assert await soon(task) == ["error bus.closed"]
        with pytest.raises(BusRequestError) as closed:
            await soon(awaited)
        assert closed.value.code == "bus.closed"

    run(scenario())
