"""The agent at one knowledge base: what its stream names, how it is confirmed there, and what ends its work there.

`docs/protocol/WORKER-SERVICE.md` § The agent, § Knowledge bases and
§ Stopping state it, and the worker service's conformance suite holds a
started service to them. Here is what that suite cannot make happen, a held
job that stalls, and the claiming itself over the SDK's doubles
(`holding.py`), with the knowledge base's sign-in and stream stood in for
(`gateways.py`).
"""

import asyncio
import logging
import re
from typing import Final

import pytest
from aio import pass_time, run, turns
from gateways import KnowledgeBaseStoodIn, stand_in
from holding import DOMAIN, EVERY_JOB, SOURCE, Parties, answering, job
from semiont.errors import SemiontError, SignInError, TransportError
from semiont.http import SecretCredential, ServiceToken
from semiont.identifiers import UserId
from semiont.model import written
from semiont.operations import OPERATIONS
from semiont.types import WorkerEngineConfig, WorkerKnowledgeBaseConfig
from standing_in import GENERATOR

from semiont_worker import agent
from semiont_worker.agent import (
    WORKER_CHANNELS,
    AgentWorker,
    EngineAtWork,
    KnowledgeBaseRefused,
    KnowledgeBaseTrouble,
    run_what_is_claimed,
    watch_for_a_stall,
)

AGENT: Final = UserId("did:web:test.local:agents:semiont-worker")


def entry(provider: str, model: str, motivation: str) -> WorkerEngineConfig:
    """An entry of a knowledge base's `engines`: an engine used for one motivation of `mark` jobs."""
    return WorkerEngineConfig.model_validate(
        {
            "engine": {"provider": provider, "model": model},
            "jobs": [{"jobType": "mark", "params": {"motivation": motivation}}],
            "baseUrl": "http://127.0.0.1:1",
        }
    )


def logged(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.getMessage().startswith(message)]


def test_the_agent_s_stream_names_the_replies_of_what_a_worker_awaits_the_two_broadcasts_it_reads_and_the_request_it_answers() -> None:
    # The reply channels of every operation a client can ask reach every stream that names them: a worker names its own.
    awaited = ("job:claim", "mark:commit", "browse:annotation-requested", "browse:resource-requested", "browse:kb-requested")
    replies = [channel.name for operation in awaited for channel in (OPERATIONS[operation].result, OPERATIONS[operation].failure)]
    assert sorted(WORKER_CHANNELS) == sorted([*replies, "job:queued", "job:cancel-requested", "job:limits-requested"])
    assert len(set(WORKER_CHANNELS)) == len(WORKER_CHANNELS)


def test_each_job_claimed_is_run_and_the_next_is_claimed_when_it_is_settled() -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.queue.extend([job("job-1", "mark", {"motivation": "highlighting"}), job("job-2", "mark", {"motivation": "highlighting"})])
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            working = asyncio.ensure_future(
                run_what_is_claimed(client, claims, inference=answering("[]"), generator=GENERATOR, accepts=EVERY_JOB, domain=DOMAIN)
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


def test_a_claim_refused_as_unauthorized_refuses_the_knowledge_base_and_leaves_the_saying_of_it_to_its_supervisor(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.claim_refused = {"code": "unauthorized", "message": "This agent is not a worker"}
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            with pytest.raises(KnowledgeBaseRefused) as refused:
                await run_what_is_claimed(client, claims, inference=answering("[]"), generator=GENERATOR, accepts=EVERY_JOB, domain=DOMAIN)
            assert str(refused.value) == "a claim there was refused as unauthorized: this worker's grant there is gone"
            # It claimed once: no later claim there changes a grant that is gone.
            assert parties.claims == 1
        await parties.transport.close()

    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(scenario())
    # The refusal is said once, by what supervises the knowledge base, and the dispatcher's words are not repeated.
    assert [record for record in caplog.records if record.name == "semiont_worker" and record.levelno >= logging.WARNING] == []


def test_a_claim_refused_for_any_other_reason_is_said_in_the_log_and_the_engine_claims_again_when_it_is_woken(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.claim_refused = {"code": "peer-unavailable", "message": "The queue cannot be reached"}
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            working = asyncio.ensure_future(
                run_what_is_claimed(client, claims, inference=answering("[]"), generator=GENERATOR, accepts=EVERY_JOB, domain=DOMAIN)
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

    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(scenario())
    (declined,) = logged(caplog, "Claim declined; parked until the next wake-up")
    assert (declined.levelname, vars(declined)["domain"], vars(declined)["code"], vars(declined)["refusal"]) == (
        "WARNING",
        DOMAIN,
        "bus.peer-unavailable",
        "The queue cannot be reached",
    )


def test_a_held_job_that_stalls_is_trouble_that_says_which_job_and_how_long_it_was_silent() -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.queue.append(job("job-1", "mark", {"motivation": "highlighting"}))
        async with parties.client as client:
            claims = client.job.claim(EVERY_JOB, held_job_stall_ms=900_000, held_job_stall_check_ms=60_000)
            watching = asyncio.ensure_future(watch_for_a_stall(claims))
            # The job is held, and nothing is done for it.
            held = await anext(claims)
            await turns()

            # Short of the threshold the job is not stalled.
            await pass_time(840, step=60)
            assert not watching.done()
            await pass_time(180, step=60)
            with pytest.raises(KnowledgeBaseTrouble) as stalled:
                await asyncio.wait_for(watching, 5)
            said = str(stalled.value)
            assert said.startswith("the job job-1 (mark), held since ")
            assert ", has shown no activity since " in said
            assert said.endswith(" ms, past 900000 ms")
            assert held is not None
            await claims.aclose()
        await parties.transport.close()

    run(scenario())


def test_an_engine_that_holds_nothing_is_never_stalled() -> None:
    async def scenario() -> None:
        parties = Parties()
        async with parties.client as client:
            claims = client.job.claim(EVERY_JOB, held_job_stall_ms=900_000, held_job_stall_check_ms=60_000)
            watching = asyncio.ensure_future(watch_for_a_stall(claims))
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

    run(scenario())


def test_what_an_engine_makes_names_the_agent_by_its_did_and_the_engine_and_no_name_and_its_health_says_which_engine_it_is() -> None:
    highlighting = entry("ollama", "gemma2:27b", "highlighting")

    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.queue.append(job("job-1", "mark", {"motivation": "highlighting"}))
        async with parties.client as client:
            engine = EngineAtWork(
                highlighting, answering('[{"exact": "the first program"}]'), client.job.claim(highlighting.jobs), domain=DOMAIN
            )
            working = asyncio.ensure_future(engine.work(client, AGENT))
            for _ in range(20):
                await turns()
            ((_, annotations),) = parties.commits
            assert [annotation["generator"] for annotation in annotations if isinstance(annotation, dict)] == [
                {"@type": "Software", "@id": AGENT, "provider": "ollama", "model": "gemma2:27b"}
            ]
            said = written(engine.health())
            assert (said["engine"], said["jobs"], said["jobsCompleted"], said["activeJob"]) == (
                {"provider": "ollama", "model": "gemma2:27b"},
                [{"jobType": "mark", "params": {"motivation": "highlighting"}}],
                1,
                None,
            )
            # Stopped, its work returns.
            await engine.stop()
            await asyncio.wait_for(working, 5)
        await parties.transport.close()

    run(scenario())


def test_engines_on_one_stream_each_claim_with_their_own_filters_and_one_whose_claiming_ends_unstopped_is_trouble() -> None:
    highlighting, commenting = entry("ollama", "gemma2:27b", "highlighting"), entry("ollama", "llama3", "commenting")

    async def scenario() -> None:
        parties = Parties()
        async with parties.client as client:
            claims = [client.job.claim(each.jobs) for each in (highlighting, commenting)]
            engines = [
                EngineAtWork(each, answering("[]"), claimed, domain=DOMAIN)
                for each, claimed in zip((highlighting, commenting), claims, strict=True)
            ]
            working = [asyncio.ensure_future(engine.work(client, AGENT)) for engine in engines]
            for _ in range(5):
                await turns()
            # Each claimed once its claims were first read, and was told nothing is pending.
            assert parties.claims == 2

            # The first's claiming ends with nothing having stopped it, as it does when the stream ends. The second's goes on.
            await claims[0].aclose()
            with pytest.raises(KnowledgeBaseTrouble, match=r"^the stream there ended: nothing more can be claimed$"):
                await asyncio.wait_for(working[0], 5)
            assert not working[1].done()
            await engines[1].stop()
            await asyncio.wait_for(working[1], 5)
        await parties.transport.close()

    run(scenario())


GATEWAY: Final = "http://gateway.test"
SERVICE: Final = ServiceToken(SecretCredential(issuer="http://issuer.test", client_id="semiont-worker", client_secret="unused"))
CLIENT_ID: Final = "semiont-worker-of-test-local"


def knowledge_base(*engines: WorkerEngineConfig) -> WorkerKnowledgeBaseConfig:
    """The entry of the document for the one knowledge base here, offered `engines`."""
    return WorkerKnowledgeBaseConfig.model_validate(
        {
            "domain": DOMAIN,
            "gatewayUrl": GATEWAY,
            "identity": {"issuer": "http://issuer.test", "clientId": CLIENT_ID},
            "engines": [engine.model_dump(mode="json", by_alias=True, exclude_none=True) for engine in engines],
        }
    )


def nothing_to_script(parties: Parties, life: int) -> None:
    """A stream over a knowledge base that holds nothing and is what its entry says."""


def test_the_agent_signs_in_once_confirms_the_knowledge_base_says_what_it_is_called_and_runs_every_engine_over_one_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    highlighting, commenting = entry("ollama", "gemma2:27b", "highlighting"), entry("ollama", "llama3", "commenting")
    there = KnowledgeBaseStoodIn(GATEWAY, DOMAIN, AGENT, each_life=nothing_to_script)
    stand_in(monkeypatch, there)

    async def scenario() -> None:
        worker = AgentWorker(knowledge_base(highlighting, commenting), [answering("[]"), answering("[]")], service=SERVICE)
        async with worker:
            await worker.open()
            working = asyncio.ensure_future(worker.work())
            for _ in range(5):
                await turns()
            # One sign-in and one stream, whatever the engines; each engine claims with its own filters.
            assert there.sign_ins == 1
            assert there.channels == [WORKER_CHANNELS]
            parties = there.parties
            assert parties.claims == 2
            # Once the stream is open the knowledge base is asked which it is; then, before any engine claims, the agent
            # says what it is called there: the client id its entry names.
            assert [frame.channel for frame in parties.frames()][:3] == ["browse:kb-requested", "principal:profile", "job:claim"]
            assert parties.sent("principal:profile") == [{"name": CLIENT_ID}]
            health = worker.health()
            assert (health.domain, health.state, health.did) == (DOMAIN, "working", AGENT)
            assert health.engines is not None
            assert [(each.engine.provider, each.engine.model) for each in health.engines] == [
                ("ollama", "gemma2:27b"),
                ("ollama", "llama3"),
            ]
            # Stopped, its work returns.
            await worker.stop()
            await asyncio.wait_for(working, 5)

    run(scenario())


def test_a_knowledge_base_that_answers_another_domain_or_cannot_say_is_refused_and_told_nothing_more(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def elsewhere(parties: Parties, life: int) -> None:
        parties.domain = "elsewhere.example" if life == 0 else None

    there = KnowledgeBaseStoodIn(GATEWAY, DOMAIN, AGENT, each_life=elsewhere)
    stand_in(monkeypatch, there)

    async def scenario() -> None:
        for said in ("it answered browse:kb-requested as elsewhere.example", "it answered browse:kb-requested with browse:kb-failed"):
            worker = AgentWorker(knowledge_base(entry("ollama", "gemma2:27b", "highlighting")), [answering("[]")], service=SERVICE)
            async with worker:
                with pytest.raises(KnowledgeBaseRefused) as refused:
                    await worker.open()
                assert str(refused.value).startswith(said)
            # Asked which it is, and told nothing more: no name, and no claim.
            assert [frame.channel for frame in there.parties.frames()] == ["browse:kb-requested"]

    run(scenario())


def test_a_knowledge_base_that_does_not_say_which_it_is_within_the_request_s_deadline_is_trouble(monkeypatch: pytest.MonkeyPatch) -> None:
    def never_open(parties: Parties, life: int) -> None:
        parties.transport.set_state("reconnecting")

    there = KnowledgeBaseStoodIn(GATEWAY, DOMAIN, AGENT, each_life=never_open)
    stand_in(monkeypatch, there)

    async def scenario() -> None:
        worker = AgentWorker(knowledge_base(entry("ollama", "gemma2:27b", "highlighting")), [answering("[]")], service=SERVICE)
        async with worker:
            opening = asyncio.ensure_future(worker.open())
            await pass_time(29, step=1)
            assert not opening.done()
            await pass_time(2, step=1)
            said = "it did not say which knowledge base it is: Bus request timed out after 30000ms on browse:kb-result"
            with pytest.raises(KnowledgeBaseTrouble, match=rf"^{re.escape(said)}$"):
                await opening

    run(scenario())


@pytest.mark.parametrize(
    ("failure", "refused"),
    [
        (SignInError("exchange", "Client-credentials grant for semiont-worker at http://issuer.test failed (HTTP 401)", status=401), True),
        (SignInError("discovery", "OIDC discovery for http://issuer.test failed: HTTP 404", status=404), True),
        (TransportError.of_status("the gateway did not name the agent (HTTP 403)", 403, None), True),
        (SignInError("exchange", "Client-credentials grant for semiont-worker at http://issuer.test got no answer"), False),
        (SignInError("exchange", "Client-credentials grant for semiont-worker at http://issuer.test failed (HTTP 503)", status=503), False),
        (TransportError.of_status("the gateway did not name the agent (HTTP 429)", 429, None), False),
        (TransportError.without_response("http://gateway.test/api/users/me got no answer"), False),
    ],
    ids=["grant refused", "no discovery", "not named", "no answer", "issuer down", "not now", "gateway unanswered"],
)
def test_a_sign_in_the_refresh_rule_would_not_try_again_is_a_refusal_and_any_other_is_trouble(
    monkeypatch: pytest.MonkeyPatch, failure: SemiontError, refused: bool
) -> None:
    there = KnowledgeBaseStoodIn(GATEWAY, DOMAIN, AGENT, each_life=nothing_to_script)
    there.refusing.append(failure)
    stand_in(monkeypatch, there)

    async def scenario() -> None:
        worker = AgentWorker(knowledge_base(entry("ollama", "gemma2:27b", "highlighting")), [answering("[]")], service=SERVICE)
        with pytest.raises(KnowledgeBaseRefused if refused else KnowledgeBaseTrouble) as ended:
            async with worker:
                pytest.fail("signed in where the sign-in failed")
        assert str(ended.value) == failure.message
        # No stream was opened.
        assert there.lives == []

    run(scenario())


def test_a_claim_refused_as_unauthorized_ends_the_agent_s_work_there_as_a_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    def unauthorized(parties: Parties, life: int) -> None:
        parties.claim_refused = {"code": "unauthorized", "message": "This agent is not a worker"}

    stand_in(monkeypatch, KnowledgeBaseStoodIn(GATEWAY, DOMAIN, AGENT, each_life=unauthorized))

    async def scenario() -> None:
        worker = AgentWorker(knowledge_base(entry("ollama", "gemma2:27b", "highlighting")), [answering("[]")], service=SERVICE)
        async with worker:
            await worker.open()
            with pytest.raises(KnowledgeBaseRefused):
                await asyncio.wait_for(worker.work(), 5)

    run(scenario())


def test_a_stall_ends_every_engine_s_work_there_each_failing_the_job_it_holds_first_and_none_claims_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    highlighting, commenting = entry("ollama", "gemma2:27b", "highlighting"), entry("ollama", "llama3", "commenting")

    def held_jobs(parties: Parties, life: int) -> None:
        parties.queue.extend([job("job-1", "mark", {"motivation": "highlighting"}), job("job-2", "mark", {"motivation": "commenting"})])

    there = KnowledgeBaseStoodIn(GATEWAY, DOMAIN, AGENT, each_life=held_jobs)
    stand_in(monkeypatch, there)
    wedged = asyncio.Event()

    async def run_job(*_: object, **__: object) -> None:
        # A job that is begun and never shows activity again.
        await wedged.wait()

    monkeypatch.setattr(agent, "run_job", run_job)

    async def scenario() -> None:
        worker = AgentWorker(knowledge_base(highlighting, commenting), [answering("[]"), answering("[]")], service=SERVICE)
        async with worker:
            await worker.open()
            working = asyncio.ensure_future(worker.work())
            await turns()
            parties = there.parties
            assert parties.claims == 2
            await pass_time(1020, step=60)
            with pytest.raises(KnowledgeBaseTrouble, match="has shown no activity"):
                await asyncio.wait_for(working, 5)
            # Both were held, and both are failed while the stream carries messages. No other is claimed.
            assert sorted(str(failed["jobId"]) for failed in parties.sent("job:fail")) == ["job-1", "job-2"]
            assert parties.claims == 2

    run(scenario())


def test_an_agent_says_nothing_of_itself_before_it_is_signed_in_and_its_stream_is_open(monkeypatch: pytest.MonkeyPatch) -> None:
    stand_in(monkeypatch, KnowledgeBaseStoodIn(GATEWAY, DOMAIN, AGENT, each_life=nothing_to_script))

    async def scenario() -> None:
        worker = AgentWorker(knowledge_base(entry("ollama", "gemma2:27b", "highlighting")), [answering("[]")], service=SERVICE)
        with pytest.raises(RuntimeError, match="not signed in"):
            await worker.open()
        async with worker:
            with pytest.raises(RuntimeError, match="stream is not open"):
                worker.health()
            # One not yet open holds nothing, and has nothing to stop.
            await worker.stop()

    run(scenario())
