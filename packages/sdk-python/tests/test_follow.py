"""Following a job (`docs/protocol/JOBS.md` § Following a job).

Through the two methods that create one: `mark.assist` and `yield_.from_context`.
"""

import asyncio
from typing import assert_never

import pytest
from aio import pass_time, run, soon, turns
from doubles import RecordingContent, RecordingGateway
from pydantic import JsonValue
from scripted_transport import Scripted
from spec import JsonObject

from semiont.channels import BRIDGED_CHANNELS
from semiont.client import ClientTiming, SemiontClient
from semiont.errors import BusRequestError, JobError, SemiontError
from semiont.identifiers import ResourceId
from semiont.namespaces.follow import JobAttemptFailed, JobCompleted, JobEvent, JobProgressed
from semiont.namespaces.mark import MarkAssistOptions
from semiont.namespaces.yield_ import generation_stall_deadline_ms
from semiont.running import Running
from semiont.timing import GENERATION_STALL_FLOOR_MS, JOB_SILENCE_MS, JOB_STATUS_POLL_MS
from semiont.transport import Frame
from semiont.types import GenerationJobParams

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

type Client = SemiontClient[Scripted]


def world(*, answered: bool = True) -> tuple[Client, Scripted]:
    """A client whose `job:create` is answered with `job-1`, or by the test when it is not `answered`."""
    transport = Scripted(BRIDGED_CHANNELS, "open")
    transport.answers = {"job:create": [{"jobId": "job-1"}]} if answered else None
    return SemiontClient(transport, RecordingContent(), RecordingGateway()), transport


def highlighting(client: Client) -> Running[JobEvent]:
    return client.mark.assist(RESOURCE, "highlighting", MarkAssistOptions())


def generation(client: Client, *, stall_deadline_ms: int | None, max_tokens: int | None = None) -> Running[JobEvent]:
    stated: JsonObject = {"title": "A summary", "storageUri": "file://a-summary.md", "context": CONTEXT}
    if max_tokens is not None:
        stated["maxTokens"] = max_tokens
    return client.yield_.from_context(GenerationJobParams.model_validate(stated), stall_deadline_ms=stall_deadline_ms)


def say(client: Client, channel: str, job_id: str, **more: JsonValue) -> None:
    client.bus.emit(channel, {"resourceId": "res-1", "jobId": job_id, "jobType": "highlight-annotation", **more})


def progress(percentage: float) -> JsonObject:
    return {"percentage": percentage, "progress": {"percentage": percentage}}


def status(of: str, **more: JsonValue) -> JsonObject:
    return {
        "jobId": "job-1",
        "type": "highlight-annotation",
        "status": of,
        "userId": "did:web:example.org:users:alice",
        "created": "2026-10-01T00:00:00.000Z",
        **more,
    }


def asked(transport: Scripted, channel: str) -> list[Frame]:
    return [frame for frame in transport.emitted if frame.channel == channel]


def kind(event: JobEvent) -> str:
    match event:
        case JobProgressed(data=data):
            return f"progress {data.percentage:g}"
        case JobAttemptFailed():
            return "failed"
        case JobCompleted():
            return "complete"
        case _:
            assert_never(event)


async def collected(running: Running[JobEvent], seen: list[JobEvent]) -> list[str]:
    """Everything a follower gives, as words: each event's kind, and the code of the failure that ended it."""
    kinds: list[str] = []
    try:
        async for event in running:
            seen.append(event)
            kinds.append(kind(event))
    except SemiontError as error:
        kinds.append(f"error {error.code}")
    return kinds


def following(running: Running[JobEvent]) -> tuple[asyncio.Task[list[str]], list[JobEvent]]:
    seen: list[JobEvent] = []
    return asyncio.ensure_future(collected(running, seen)), seen


def test_a_job_reports_its_progress_and_ends_with_its_completion() -> None:
    async def scenario() -> None:
        client, transport = world()
        task, seen = following(highlighting(client))
        await turns()
        assert [(frame.channel, dict(frame.payload)) for frame in transport.emitted] == [
            ("job:create", {"jobType": "highlight-annotation", "resourceId": "res-1", "params": {}})
        ]
        say(client, "job:report-progress", "job-1", **progress(10))
        # Another job's frames are not this follower's.
        say(client, "job:report-progress", "job-2", **progress(99))
        say(client, "job:complete", "job-2")
        say(client, "job:report-progress", "job-1", **progress(60))
        # Progress that states nothing of how far the job is, reports nothing.
        say(client, "job:report-progress", "job-1", percentage=70)
        say(client, "job:complete", "job-1", result={"kind": "highlight-annotation", "highlightsFound": 2, "highlightsCreated": 2})
        assert await soon(task) == ["progress 10", "progress 60", "complete"]
        last = seen[-1]
        assert isinstance(last, JobCompleted)
        assert (last.kind, last.data.job_id, last.data.resource_id) == ("complete", "job-1", "res-1")
        assert asked(transport, "job:status-requested") == []
        await client.close()

    run(scenario())


def test_awaited_a_job_gives_its_completion() -> None:
    async def scenario() -> None:
        client, _ = world()
        awaiting = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        say(client, "job:report-progress", "job-1", **progress(10))
        say(client, "job:complete", "job-1")
        done = await soon(awaiting)
        assert isinstance(done, JobCompleted)
        await client.close()

    run(scenario())


async def _awaited(running: Running[JobEvent]) -> JobEvent:
    return await running


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
        assert transport.answers is not None
        transport.answers["job:status-requested"] = [status("running"), status("complete")]
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
        assert (done.data.job_id, done.data.resource_id, done.data.job_type, done.data.result) == (
            "job-1",
            "res-1",
            "highlight-annotation",
            None,
        )
        await client.close()

    run(scenario())


def test_a_status_carries_the_result_its_job_was_stored_with_and_an_empty_one_is_none() -> None:
    async def scenario(result: JsonValue) -> JobEvent:
        client, transport = world()
        assert transport.answers is not None
        transport.answers["job:status-requested"] = [status("complete", result=result)]
        task, seen = following(highlighting(client))
        await turns()
        await pass_time(SILENCE + 0.1, step=0.5)
        assert await soon(task) == ["complete"]
        await client.close()
        return seen[0]

    stored = run(scenario({"kind": "highlight-annotation", "highlightsFound": 3, "highlightsCreated": 2}))
    assert isinstance(stored, JobCompleted)
    assert stored.data.result is not None
    assert stored.data.result.kind == "highlight-annotation"
    empty = run(scenario({}))
    assert isinstance(empty, JobCompleted)
    assert empty.data.result is None


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
        assert transport.answers is not None
        transport.answers["job:status-requested"] = [status(of, **more)]
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


@pytest.mark.parametrize(
    ("motivation", "options", "message"),
    [
        ("tagging", MarkAssistOptions(categories=["claim"]), 'mark.assist with motivation "tagging" requires options.schemaId'),
        (
            "tagging",
            MarkAssistOptions(schema_id="s1"),
            'mark.assist with motivation "tagging" requires a non-empty options.categories array',
        ),
        (
            "tagging",
            MarkAssistOptions(schema_id="s1", categories=[]),
            'mark.assist with motivation "tagging" requires a non-empty options.categories array',
        ),
        ("linking", MarkAssistOptions(), 'mark.assist with motivation "linking" requires a non-empty entityTypes array'),
        ("linking", MarkAssistOptions(entity_types=[]), 'mark.assist with motivation "linking" requires a non-empty entityTypes array'),
    ],
    ids=["tagging, no schema", "tagging, no categories", "tagging, empty categories", "linking, no types", "linking, empty types"],
)
def test_an_assist_its_job_could_not_run_is_refused_before_anything_is_sent(
    motivation: str, options: MarkAssistOptions, message: str
) -> None:
    async def scenario() -> None:
        client, transport = world()
        # Nothing is raised where it is called: its refusal is its failure, heard where any other is.
        running = client.mark.assist(RESOURCE, "tagging" if motivation == "tagging" else "linking", options)
        with pytest.raises(BusRequestError) as refused:
            await soon(running)
        assert (refused.value.code, refused.value.message) == ("bus.rejected", message)
        assert transport.emitted == []
        await client.close()

    run(scenario())


def test_a_job_whose_creation_is_refused_is_its_followers_failure() -> None:
    async def scenario() -> None:
        client, transport = world()
        transport.answers = {}
        with pytest.raises(BusRequestError) as refused:
            await soon(highlighting(client))
        assert refused.value.code == "bus.rejected"
        await client.close()

    run(scenario())


# ── A generation, which may stall ───────────────────────────────────────


def test_a_generation_that_says_nothing_is_cancelled_and_given_up_on() -> None:
    async def scenario() -> None:
        client, transport = world()
        assert transport.answers is not None
        # Its status says it is running for as long as it is asked: only the deadline ends it.
        transport.answers["job:status-requested"] = [status("running")] * 50
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
        # That job and no other: a cancellation by category would end every pending job of it.
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
        say(client, "job:report-progress", "job-1", **progress(10))
        await pass_time(25, step=1)
        # The setback was heard: a deadline left running would cancel the attempt that is coming.
        say(client, "job:fail", "job-1", error="a blip", willRetry=True)
        await pass_time(25, step=1)
        assert not task.done()
        assert asked(transport, "job:cancel-requested") == []
        say(client, "job:complete", "job-1")
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
        assert transport.answers is not None
        transport.answers["job:status-requested"] = [status("running")] * 100
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
        transport = Scripted(BRIDGED_CHANNELS, "open")
        transport.answers = {"job:create": [{"jobId": "job-1"}], "job:status-requested": [status("complete")]}
        client = SemiontClient(
            transport, RecordingContent(), RecordingGateway(), timing=ClientTiming(job_silence_ms=50, job_status_poll_ms=20)
        )
        assert (client.timing.job_silence_ms, client.timing.bus_request_ms) == (50, 30_000)
        # No clock is moved: a twentieth of a second is waited out.
        done = await soon(highlighting(client))
        assert isinstance(done, JobCompleted)
        await client.close()

    run(scenario())


def test_a_client_that_closes_ends_the_jobs_it_was_following() -> None:
    async def scenario() -> None:
        client, transport = world()
        assert transport.answers is not None
        transport.answers["job:create"].append({"jobId": "job-2"})
        task, _ = following(highlighting(client))
        awaited = asyncio.ensure_future(_awaited(highlighting(client)))
        await turns()
        await client.close()
        assert await soon(task) == ["error bus.closed"]
        with pytest.raises(BusRequestError) as closed:
            await soon(awaited)
        assert closed.value.code == "bus.closed"

    run(scenario())
