"""The README's programs: each Python block it shows is a file of `tests/readme`, word for word, and each is run here.

Both type checkers check those files with the rest of the package. What needs
a gateway runs against this package's scripted one, on this machine; what
takes a client runs over `semiont.testing`'s doubles.
"""

import asyncio
import importlib
import re
from collections.abc import Callable
from pathlib import Path

import pytest
from aio import hurried, run, settle, soon
from gateway_server import GatewayServer
from issuer import AGENT, ALICE, ME, PENDING, SECRET, TOKEN, agent_token, issuer_of, minted, says, trusting
from kb import answer, asked_for, knowing, recorded, refusing, silent
from readme import a_first_program, a_person, an_agent, content, live_queries, testing, the_bus, the_client
from spec import PACKAGE, JsonObject
from tokens import token

from semiont.bus import reply_channels_for
from semiont.http import HttpTransport
from semiont.identifiers import AnnotationId, ResourceId
from semiont.operations import JOB_CLAIM
from semiont.sign_in_store import FILE_NAME, SignInStore, state_dir, this_system
from semiont.testing import FaultyTransport, PutBinary, create_test_client
from semiont.transport import Content, Frame
from semiont.watched import Variable

README = (PACKAGE / "README.md").read_text(encoding="utf-8")
PROGRAMS = {
    path.stem: path.read_text(encoding="utf-8") for path in sorted((PACKAGE / "tests/readme").glob("*.py")) if path.stem != "__init__"
}
RESOURCE, ANNOTATION = ResourceId("res-1"), AnnotationId("ann-1")
DESCRIBED: JsonObject = {
    "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "representations": []},
    "annotations": [],
    "entityReferences": [],
}
STATUS: JsonObject = {
    "status": "ok",
    "version": "0.0.0",
    "features": {"semanticContent": "on", "collaboration": "on"},
    "message": "serving",
}


def python_blocks(markdown: str) -> list[str]:
    """The fenced Python blocks of a Markdown document, in order."""
    return re.findall(r"^```python\n(.*?)^```$", markdown, re.DOTALL | re.MULTILINE)


async def until(what: str, seen: Callable[[], bool]) -> None:
    """Wait, a second at most, for `seen` to hold."""
    for _ in range(200):
        if seen():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"{what} did not happen")


def test_every_python_block_of_the_readme_is_a_program_here_word_for_word_and_every_program_is_shown() -> None:
    shown = python_blocks(README)
    assert len(PROGRAMS) >= 9
    for block in shown:
        assert block in PROGRAMS.values(), f"a Python block of the README is not a program that is checked and run:\n{block}"
    for name, program in PROGRAMS.items():
        assert shown.count(program) == 1, f"tests/readme/{name}.py is not shown in the README, once, as it is"


def test_every_program_is_run_by_a_test_named_for_it() -> None:
    tests = [name for name in globals() if name.startswith("test_")]
    for name in PROGRAMS:
        assert any(test.startswith(f"test_{name}_") for test in tests), f"nothing here runs tests/readme/{name}.py"


def test_the_kinds_of_id_says_what_its_comments_say(capsys: pytest.CaptureFixture[str]) -> None:
    # A script: importing it runs it. Run again, whatever first imported it.
    importlib.reload(importlib.import_module("readme.the_kinds_of_id"))
    refusal, written = capsys.readouterr().out.splitlines()[-2:]
    assert refusal == "'https://kb.example/resources/x' is not a ResourceId: it does not match ^[A-Za-z0-9_-]{1,128}$"
    assert written == "{'annotationId': 'a-1', 'resourceId': '5bcd259ab1464cf68a556bbad21f513f'}"
    # What it prints is what it says it prints.
    program = PROGRAMS["the_kinds_of_id"]
    assert f"print(refused)  # {refusal}\n" in program
    assert f"\n# {written}\n" in program


def test_the_bus_reads_a_resource_then_its_frames_and_says_the_code_of_a_request_that_fails(capsys: pytest.CaptureFixture[str]) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:

            def answering(emit: JsonObject) -> None:
                if emit["payload"] == {"resourceId": "res-1"}:
                    gateway.send(
                        None,
                        {"channel": "browse:resource-result", "payload": {"response": DESCRIBED}, "correlationId": emit["correlationId"]},
                    )
                else:
                    refused: JsonObject = {"code": "not-found", "message": "no such resource"}
                    gateway.send(None, {"channel": "browse:resource-failed", "payload": refused, "correlationId": emit["correlationId"]})

            gateway.on_emit = answering
            reading = asyncio.ensure_future(the_bus.read(gateway.origin, "a-token", RESOURCE))
            # Its scope is on the stream: a second subscription, the first with a scope.
            await soon(gateway.streams(2))
            await settle()
            assert gateway.of("POST", "/bus/subscribe")[0].headers["authorization"] == "Bearer a-token"
            gateway.send("p-1", {"channel": "mark:added", "payload": recorded("mark:added", "res-1"), "scope": "res-1"})
            await settle()
            await settle()
            # It reads frames for as long as it is left to.
            assert not reading.done()
            reading.cancel()
            await asyncio.gather(reading, return_exceptions=True)

            await soon(the_bus.read(gateway.origin, "a-token", ResourceId("res-2")))

    run(scenario())
    assert capsys.readouterr().out.splitlines() == ["A resource", "res-1 mark:added", "bus.not-found"]


def test_content_stores_a_page_reads_it_back_and_asks_the_gateway_who_it_is(capsys: pytest.CaptureFixture[str]) -> None:
    page = b"# A page\n\nWith a line of text.\n"

    async def scenario() -> ResourceId:
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("a-token"), channels=()) as transport,
        ):
            # The scripted gateway names an upload and keeps nothing of it: what a read of it gives is said here.
            gateway.stored["res-uploaded-1"] = ("text/markdown", page)
            gateway.answers[ME] = ALICE
            gateway.answers["/api/health"] = {
                "status": "ok",
                "message": "serving",
                "version": "0.0.0",
                "timestamp": "2026-10-06T00:00:00.000Z",
            }
            created = await soon(content.store(transport, page))
            (uploaded,) = gateway.of("POST", "/resources")
            assert uploaded.form()["file"][0] == page
            return created

    assert run(scenario()) == "res-uploaded-1"
    *progress, piece, me = capsys.readouterr().out.splitlines()
    assert progress
    sent, _, total = progress[-1].partition(" of ")
    assert sent == total
    assert (piece, me) == (str(len(page)), "did:web:example.org:users:alice ok")


def test_a_first_program_ingests_a_paper_has_it_annotated_gathers_its_context_and_generates_a_summary() -> None:
    paper = b"%PDF-1.7 the paper"
    gathered: JsonObject = {
        "focus": {
            "kind": "resource",
            "resource": {
                "@context": "https://schema.org",
                "@id": "test-content-1",
                "name": "Attention Is All You Need",
                "representations": [{"mediaType": "application/pdf"}],
            },
        },
        "graph": {"nodes": [], "edges": []},
        "metadata": {},
    }

    def completion(job: str, job_type: str, result: JsonObject) -> Frame:
        return Frame(channel="job:complete", payload={"resourceId": "test-content-1", "jobId": job, "jobType": job_type, "result": result})

    async def scenario() -> None:
        # The test answers each request itself, so it says when each step is allowed to end.
        made = create_test_client(transport=silent())

        async def asked(operation: str, count: int) -> Frame:
            await until(f"request {count} of {operation}", lambda: len(asked_for(made.transport, operation)) == count)
            return asked_for(made.transport, operation)[-1]

        async with made.client as client:
            summarizing = asyncio.ensure_future(a_first_program.summarize(client, paper))

            assist = await asked("job:create", 1)
            answer(made.transport, assist, {"jobId": "job-1"})
            # Nothing is gathered until the model has finished marking.
            await settle()
            assert asked_for(made.transport, "gather:resource-requested") == []
            linked: JsonObject = {"kind": "reference-annotation", "totalFound": 3, "totalEmitted": 3, "errors": 0}
            made.transport.deliver(completion("job-1", "reference-annotation", linked))

            gather = await asked("gather:resource-requested", 1)
            # This reply names its resource beside the response.
            reply: JsonObject = {"resourceId": "test-content-1", "response": gathered}
            made.transport.deliver(Frame(channel="gather:resource-complete", payload=reply, correlation_id=gather.correlation_id))

            generation = await asked("job:create", 2)
            answer(made.transport, generation, {"jobId": "job-2"})
            generated: JsonObject = {"kind": "generation", "resourceId": "res-summary", "resourceName": "A summary", "truncated": False}
            made.transport.deliver(completion("job-2", "generation", generated))
            assert await soon(summarizing) == ResourceId("res-summary")

        # The paper was uploaded as it was given, under the name and the place the program states.
        [uploaded] = [call for call in made.content.calls if isinstance(call, PutBinary)]
        assert (uploaded.request.file, uploaded.request.format) == (paper, "application/pdf")
        assert uploaded.request.storage_uri == "file://papers/attention-is-all-you-need.pdf"
        # It asked for concepts to be linked in that paper, gathered around it, and asked for a summary of what it gathered.
        assert (assist.payload["jobType"], assist.payload["resourceId"]) == ("reference-annotation", "test-content-1")
        assert assist.payload["params"] == {"entityTypes": ["Concept"]}
        assert gather.payload["resourceId"] == "test-content-1"
        assert generation.payload["jobType"] == "generation"
        params = generation.payload["params"]
        assert isinstance(params, dict)
        assert (params["title"], params["task"]) == ("Attention Is All You Need: a summary", "summary")
        assert params["storageUri"] == "file://generated/attention-summary.md"
        assert params["context"] == gathered
        await made.transport.close()

    run(scenario())


def test_the_client_annotates_over_the_doubles_and_over_http(capsys: pytest.CaptureFixture[str]) -> None:
    progress: JsonObject = {
        "resourceId": "res-1",
        "jobId": "job-1",
        "jobType": "highlight-annotation",
        "percentage": 50,
        "progress": {"percentage": 50},
    }
    complete: JsonObject = {
        "resourceId": "res-1",
        "jobId": "job-1",
        "jobType": "highlight-annotation",
        "result": {"kind": "highlight-annotation", "highlightsFound": 2, "highlightsCreated": 2},
    }

    async def over_the_doubles() -> None:
        made = create_test_client()
        made.transport.queue_reply("browse:resource-requested", [DESCRIBED])
        made.transport.queue_reply("job:create", [{"jobId": "job-1"}])
        made.content.seed(RESOURCE, Content(data=b"some text", content_type="text/plain"))
        async with made.client as client:
            annotating = asyncio.ensure_future(the_client.annotate(client, RESOURCE, ANNOTATION))
            await until("the job's creation", lambda: any(asked.channel == "job:create" for asked in made.transport.request_log))
            made.transport.deliver(Frame(channel="job:report-progress", payload=progress))
            made.transport.deliver(Frame(channel="job:complete", payload=complete))
            clicked = client.bus.frames_on("browse:click")
            await soon(annotating)
            assert (await soon(anext(clicked))).payload == {"annotationId": "ann-1"}
        assert [frame.channel for frame in made.transport.emitted] == ["browse:resource-requested", "job:create", "beckon:focus"]
        await made.transport.close()

    async def over_http() -> None:
        async with GatewayServer() as gateway:
            gateway.stored["res-1"] = ("text/plain", b"some text")

            def answering(emit: JsonObject) -> None:
                if emit["channel"] == "browse:resource-requested":
                    gateway.send(
                        None,
                        {"channel": "browse:resource-result", "payload": {"response": DESCRIBED}, "correlationId": emit["correlationId"]},
                    )
                elif emit["channel"] == "job:create":
                    gateway.send(
                        None,
                        {"channel": "job:created", "payload": {"response": {"jobId": "job-1"}}, "correlationId": emit["correlationId"]},
                    )
                    gateway.send("e-1", {"channel": "job:report-progress", "payload": progress})
                    gateway.send("e-2", {"channel": "job:complete", "payload": complete})

            gateway.on_emit = answering
            await soon(the_client.over_http(gateway.origin, "a-token", RESOURCE, ANNOTATION))
            assert [emit["channel"] for emit in gateway.emits] == ["browse:resource-requested", "job:create", "beckon:focus"]

    run(over_the_doubles())
    doubled = capsys.readouterr().out.splitlines()
    run(over_http())
    # The same four things said, whichever transport the client is over.
    assert capsys.readouterr().out.splitlines() == doubled
    described, half, done, reached = doubled
    assert (described, half, reached) == ("A resource 9", "50.0", "1")
    assert "highlights_created=2" in done


def test_live_queries_shows_each_state_of_a_watched_query_until_its_client_closes(capsys: pytest.CaptureFixture[str]) -> None:
    async def watched(transport: FaultyTransport) -> None:
        made = create_test_client(transport=transport)
        async with made.client as client:
            watching = asyncio.ensure_future(live_queries.watch(client, RESOURCE))
            await until("the query's last state", lambda: transport.pending_replies == [] and len(transport.request_log) >= 1)
            await settle()
            assert transport.holds(RESOURCE) == 1
            assert not watching.done()
        # Its client closed: the states ended, and so did the watching.
        await soon(watching)
        assert transport.scopes == []
        await transport.close()

    run(watched(FaultyTransport(make_response=knowing)))
    assert capsys.readouterr().out.splitlines() == ["asking", "1 annotations"]

    refused = FaultyTransport()
    refused.refuse_when(refusing("browse:annotations-requested"))
    run(watched(refused))
    # A failure is a state: the watcher lived through it, to the client's end.
    assert capsys.readouterr().out.splitlines() == ["asking", "failed: bus.rejected"]


def test_an_agent_opens_its_stream_as_the_agent_its_service_account_was_exchanged_for(capsys: pytest.CaptureFixture[str]) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[TOKEN] = {"access_token": token(3600, 0)}
            gateway.scripted[("POST", AGENT)] = [agent_token(1)]
            await soon(an_agent.work(gateway.origin, issuer_of(gateway), SECRET))
            (exchanged,) = gateway.of("POST", AGENT)
            assert exchanged.json() == {"provider": "ollama", "model": "gemma2:27b"}
            (subscribed,) = gateway.of("POST", "/bus/subscribe")
            assert subscribed.headers["authorization"] != exchanged.headers["authorization"]
            assert subscribed.json()["global"] == list(reply_channels_for(JOB_CLAIM))

    run(scenario())
    assert capsys.readouterr().out.splitlines() == ["open"]


def test_a_person_signs_in_by_the_device_grant_once_and_is_that_person_from_then_on(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers["/api/status"] = STATUS
            issued = token(3600, 1, email="alice@example.org", iss=issuer_of(gateway))
            gateway.scripted[("POST", "/realms/semiont/device")] = [minted(interval=1)]
            gateway.scripted[("POST", TOKEN)] = [PENDING, says({"access_token": issued, "refresh_token": "refresh-1"})]

            # Nothing is kept: the code is shown, and the sign-in it brings is kept where `semiont login` keeps one.
            await hurried(a_person.as_me(gateway.origin, str(tmp_path)))
            directory = state_dir(this_system(), home=str(tmp_path), xdg_state_home=None, local_app_data=None)
            assert directory is not None
            assert "local" in SignInStore(Path(directory) / FILE_NAME).read()

            # Kept: nobody is shown a code again.
            await soon(a_person.as_me(gateway.origin, str(tmp_path)))
            assert len(gateway.of("POST", "/realms/semiont/device")) == 1

    run(scenario())
    code, first, again = capsys.readouterr().out.splitlines()
    assert code == "Open https://issuer.example.org/device and enter WDJB-MJHT"
    assert first == again
    assert "alice@example.org" in first
    assert first.endswith(" 0.0.0")


def test_testing_runs_the_test_it_shows() -> None:
    run(testing.a_title_is_its_resources_name_in_title_case())
