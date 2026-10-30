"""The agent at work: what its stream names, what an engine does with a claim that is refused, and what it does when its job stalls.

`docs/protocol/WORKER-SERVICE.md` § The agent and § Stopping state it, and the
worker service's conformance suite holds a started service to both. Here is
what that suite cannot make happen, a held job that stalls, and the claiming
itself over the SDK's doubles (`holding.py`).
"""

import asyncio
import logging
import os
from typing import Final, NoReturn

import pytest
from aio import pass_time, run, turns
from holding import EVERY_JOB, SOURCE, Parties, answering, job
from semiont.identifiers import UserId
from semiont.operations import OPERATIONS
from semiont.types import WorkerAgentConfig
from standing_in import GENERATOR

from semiont_worker import agent
from semiont_worker.agent import WORKER_CHANNELS, Engine, exit_for_restart, run_what_is_claimed, watch_for_a_stall

AGENT: Final = UserId("did:web:test.local:agents:semiont-worker")


def entry(provider: str, model: str, motivation: str) -> WorkerAgentConfig:
    """An entry of the document's `agents`: an engine serving one motivation of `mark` jobs."""
    return WorkerAgentConfig.model_validate(
        {
            "agent": {"provider": provider, "model": model},
            "accepts": [{"jobType": "mark", "params": {"motivation": motivation}}],
            "baseUrl": "http://127.0.0.1:1",
        }
    )


class Left(Exception):
    """The process would have ended here, with status 1."""


def leaving(monkeypatch: pytest.MonkeyPatch) -> None:
    """Have what would end the process raise instead, so that a test sees where it would have ended."""

    def leave() -> NoReturn:
        raise Left

    monkeypatch.setattr(agent, "exit_for_restart", leave)


def logged(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.getMessage().startswith(message)]


def test_the_agent_s_stream_names_the_replies_of_what_a_worker_awaits_the_two_broadcasts_it_reads_and_the_request_it_answers() -> None:
    # The reply channels of every operation a client can ask reach every stream that names them: a worker names its own.
    awaited = ("job:claim", "mark:commit", "browse:annotation-requested", "browse:resource-requested")
    replies = [channel.name for operation in awaited for channel in (OPERATIONS[operation].result, OPERATIONS[operation].failure)]
    assert sorted(WORKER_CHANNELS) == sorted([*replies, "job:queued", "job:cancel-requested", "job:limits-requested"])
    assert len(set(WORKER_CHANNELS)) == len(WORKER_CHANNELS)


def test_ending_the_process_for_restart_ends_it_at_once_with_status_1(monkeypatch: pytest.MonkeyPatch) -> None:
    ended: list[int] = []

    def ending(status: int) -> NoReturn:
        ended.append(status)
        raise Left

    monkeypatch.setattr(os, "_exit", ending)
    with pytest.raises(Left):
        exit_for_restart()
    assert ended == [1]


def test_each_job_claimed_is_run_and_the_next_is_claimed_when_it_is_settled() -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.queue.extend([job("job-1", "mark", {"motivation": "highlighting"}), job("job-2", "mark", {"motivation": "highlighting"})])
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            working = asyncio.ensure_future(
                run_what_is_claimed(client, claims, inference=answering("[]"), generator=GENERATOR, accepts=EVERY_JOB)
            )
            for _ in range(20):
                await turns()
            assert [completion["jobId"] for completion in parties.sent("job:complete")] == ["job-1", "job-2"]
            # One claim when it began, and one as each job was settled: the last was told nothing is pending.
            assert parties.claims == 3
            assert not working.done()
            await claims.aclose()
            # The claiming ended: so does the running.
            await asyncio.wait_for(working, 5)
        await parties.transport.close()

    run(scenario())


def test_a_claim_refused_as_unauthorized_ends_the_process_and_says_why(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.claim_refused = {"code": "unauthorized", "message": "This agent is not a worker"}
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            with pytest.raises(Left):
                await run_what_is_claimed(client, claims, inference=answering("[]"), generator=GENERATOR, accepts=EVERY_JOB)
        await parties.transport.close()

    leaving(monkeypatch)
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(scenario())
    (refused,) = logged(caplog, "Claim refused: this worker is not authorized to claim jobs")
    assert (refused.levelname, vars(refused)["code"], vars(refused)["refusal"]) == (
        "ERROR",
        "bus.unauthorized",
        "This agent is not a worker",
    )
    assert len(vars(refused)["accepts"]) == len(EVERY_JOB)


def test_a_claim_refused_for_any_other_reason_is_said_in_the_log_and_the_engine_claims_again_when_it_is_woken(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.claim_refused = {"code": "peer-unavailable", "message": "The queue cannot be reached"}
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            working = asyncio.ensure_future(
                run_what_is_claimed(client, claims, inference=answering("[]"), generator=GENERATOR, accepts=EVERY_JOB)
            )
            for _ in range(5):
                await turns()
            assert parties.claims == 1
            assert not working.done()

            # The queue can be reached again, and a job is announced: it is claimed and run.
            parties.claim_refused = None
            handed_over = job("job-1", "mark", {"motivation": "highlighting"})
            parties.queue.append(handed_over)
            await parties.transport.emit(
                "job:queued",
                {
                    "jobId": "job-1",
                    "jobType": "mark",
                    "resourceId": SOURCE,
                    "userId": "did:web:test.local:users:requester",
                    "params": {"motivation": "highlighting"},
                },
            )
            for _ in range(20):
                await turns()
            assert [completion["jobId"] for completion in parties.sent("job:complete")] == ["job-1"]
            await claims.aclose()
            await asyncio.wait_for(working, 5)
        await parties.transport.close()

    leaving(monkeypatch)
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(scenario())
    (declined,) = logged(caplog, "Claim declined; parked until the next wake-up")
    assert (declined.levelname, vars(declined)["code"], vars(declined)["refusal"]) == (
        "WARNING",
        "bus.peer-unavailable",
        "The queue cannot be reached",
    )
    assert logged(caplog, "Claim refused") == []


def test_a_held_job_that_stalls_ends_the_process_and_says_which_job_and_how_long_it_was_silent(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.queue.append(job("job-1", "mark", {"motivation": "highlighting"}))
        async with parties.client as client:
            claims = client.job.claim(EVERY_JOB, held_job_stall_ms=900_000, held_job_stall_check_ms=60_000)
            watching = asyncio.ensure_future(watch_for_a_stall(claims, AGENT))
            # The job is held, and nothing is done for it.
            held = await anext(claims)
            await turns()

            # Short of the threshold the job is not stalled, and the process goes on.
            await pass_time(840, step=60)
            assert not watching.done()
            await pass_time(180, step=60)
            with pytest.raises(Left):
                await asyncio.wait_for(watching, 5)
            assert held is not None
            await claims.aclose()
        await parties.transport.close()

    leaving(monkeypatch)
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(scenario())
    (stalled,) = logged(caplog, "Worker stalled")
    said = vars(stalled)
    assert (stalled.levelname, said["agent"], said["jobId"], said["jobType"], said["thresholdMs"]) == (
        "ERROR",
        AGENT,
        "job-1",
        "mark",
        900_000,
    )
    assert said["silentForMs"] > 900_000
    for instant in ("processingSince", "lastActivityAt"):
        assert isinstance(said[instant], str)
        assert said[instant].endswith("Z")


def test_an_engine_that_holds_nothing_is_never_stalled(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        parties = Parties()
        async with parties.client as client:
            claims = client.job.claim(EVERY_JOB, held_job_stall_ms=900_000, held_job_stall_check_ms=60_000)
            watching = asyncio.ensure_future(watch_for_a_stall(claims, AGENT))
            reading = asyncio.ensure_future(anext(claims))
            await turns()
            await pass_time(3600, step=60)
            assert not watching.done()
            await claims.aclose()
            # The claiming ended, and so does the watching: nothing was left to stall.
            await asyncio.wait_for(watching, 5)
            with pytest.raises(StopAsyncIteration):
                await reading
        await parties.transport.close()

    leaving(monkeypatch)
    run(scenario())


def test_what_an_engine_makes_names_the_agent_by_its_did_and_the_engine_and_its_vitals_say_which_engine_it_is() -> None:
    highlighting = entry("ollama", "gemma2:27b", "highlighting")

    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.queue.append(job("job-1", "mark", {"motivation": "highlighting"}))
        async with parties.client as client:
            engine = Engine(highlighting, answering('[{"exact": "the first program"}]'), client.job.claim(highlighting.accepts))
            working = asyncio.ensure_future(engine.work(client, AGENT))
            for _ in range(20):
                await turns()
            ((_, annotations),) = parties.commits
            assert [annotation["generator"] for annotation in annotations if isinstance(annotation, dict)] == [
                {"@type": "Software", "@id": AGENT, "name": "ollama gemma2:27b", "provider": "ollama", "model": "gemma2:27b"}
            ]
            vitals = engine.vitals()
            assert (vitals["provider"], vitals["model"], vitals["serves"], vitals["jobsCompleted"], vitals["activeJob"]) == (
                "ollama",
                "gemma2:27b",
                [{"jobType": "mark", "params": {"motivation": "highlighting"}}],
                1,
                None,
            )
            # Stopped, its work returns.
            await engine.stop()
            await asyncio.wait_for(working, 5)
        await parties.transport.close()

    run(scenario())


def test_engines_on_one_stream_each_claim_with_their_own_filters_and_one_whose_claiming_ends_unstopped_raises() -> None:
    highlighting, commenting = entry("ollama", "gemma2:27b", "highlighting"), entry("ollama", "llama3", "commenting")

    async def scenario() -> None:
        parties = Parties()
        async with parties.client as client:
            claims = [client.job.claim(each.accepts) for each in (highlighting, commenting)]
            engines = [Engine(each, answering("[]"), claimed) for each, claimed in zip((highlighting, commenting), claims, strict=True)]
            working = [asyncio.ensure_future(engine.work(client, AGENT)) for engine in engines]
            for _ in range(5):
                await turns()
            # Each claimed once its claims were first read, and was told nothing is pending.
            assert parties.claims == 2

            # The first's claiming ends with nothing having stopped it: its work raises. The second's goes on.
            await claims[0].aclose()
            with pytest.raises(RuntimeError, match="nothing more can be claimed"):
                await asyncio.wait_for(working[0], 5)
            assert not working[1].done()
            await engines[1].stop()
            await asyncio.wait_for(working[1], 5)
        await parties.transport.close()

    run(scenario())
