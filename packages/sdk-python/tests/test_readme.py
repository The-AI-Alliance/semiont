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
from readme import (
    a_first_program,
    a_person,
    a_worker,
    an_agent,
    building_annotations,
    content,
    live_queries,
    testing,
    the_bus,
    the_client,
)
from spec import PACKAGE, ROOT, SPEC, JsonObject, objects, read
from tokens import token

from semiont.annotations import QuotedText, target_selector
from semiont.bus import reply_channels_for
from semiont.claims import JOB_CLAIM_CHANNELS, JOB_COMMIT_CHANNELS
from semiont.http import HttpTransport
from semiont.identifiers import AnnotationId, ResourceId
from semiont.identity import agent_address, agent_did
from semiont.operations import JOB_CLAIM
from semiont.sign_in_store import FILE_NAME, SignInStore, state_dir, this_system
from semiont.testing import FaultyTransport, PutBinary, create_test_client
from semiont.transport import Content, Frame
from semiont.types import AgentSoftware, AnchoredText, FragmentSelector, PdfTextItem
from semiont.watched import Variable

README = (PACKAGE / "README.md").read_text(encoding="utf-8")
SKILL = (ROOT / "docs/builder/skills/semiont-worker/SKILL.md").read_text(encoding="utf-8")
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
    assert len(PROGRAMS) >= 10
    for block in shown:
        assert block in PROGRAMS.values(), f"a Python block of the README is not a program that is checked and run:\n{block}"
    for name, program in PROGRAMS.items():
        assert shown.count(program) == 1, f"tests/readme/{name}.py is not shown in the README, once, as it is"


def test_every_python_block_of_the_worker_skill_is_a_program_here_word_for_word() -> None:
    # The skill shows a worker in Python. What it shows is a program that is checked and run here.
    shown = python_blocks(SKILL)
    assert shown, "the semiont-worker skill shows no Python block"
    for block in shown:
        assert block in PROGRAMS.values(), f"a Python block of the semiont-worker skill is not a program that is checked and run:\n{block}"


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

            linking = await asked("job:create", 1)
            answer(made.transport, linking, {"jobId": "job-1"})
            # Nothing is gathered until the model has finished marking.
            await settle()
            assert asked_for(made.transport, "gather:resource-requested") == []
            linked: JsonObject = {"found": 3, "persisted": 3}
            made.transport.deliver(completion("job-1", "mark", linked))

            gather = await asked("gather:resource-requested", 1)
            answer(made.transport, gather, gathered)

            generation = await asked("job:create", 2)
            answer(made.transport, generation, {"jobId": "job-2"})
            generated: JsonObject = {"resourceId": "res-summary", "resourceName": "A summary", "truncated": False}
            made.transport.deliver(completion("job-2", "yield", generated))
            assert await soon(summarizing) == ResourceId("res-summary")

        # The paper was uploaded as it was given, under the name and the place the program states.
        [uploaded] = [call for call in made.content.calls if isinstance(call, PutBinary)]
        assert (uploaded.request.file, uploaded.request.format) == (paper, "application/pdf")
        assert uploaded.request.storage_uri == "file://papers/attention-is-all-you-need.pdf"
        # It asked for concepts to be linked in that paper, gathered around it, and asked for a summary of what it gathered.
        assert (linking.payload["jobType"], linking.payload["resourceId"]) == ("mark", "test-content-1")
        assert linking.payload["params"] == {"motivation": "linking", "entityTypes": ["Concept"]}
        assert gather.payload["resourceId"] == "test-content-1"
        assert generation.payload["jobType"] == "yield"
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
        "jobType": "mark",
        "percentage": 50,
        "progress": {"percentage": 50},
    }
    complete: JsonObject = {
        "resourceId": "res-1",
        "jobId": "job-1",
        "jobType": "mark",
        "result": {"found": 3, "persisted": 2},
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
    # The same five things said, whichever transport the client is over.
    assert capsys.readouterr().out.splitlines() == doubled
    described, named, half, done, reached = doubled
    assert (described, named, half, reached) == ("A resource 9", "to cancel it: job-1", "50.0", "1")
    assert done.startswith("found=3 persisted=2 ")


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


def test_a_worker_claims_as_its_agent_commits_a_highlight_it_built_says_the_job_s_lifecycle_and_claims_again(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # The resource's first line is the span of the first case of the id table: the id it states is the highlight's.
    stated = objects(read(SPEC / "annotations/id-cases.json")["cases"], "the id table's cases")[0]
    assert (stated["resourceId"], stated["motivation"], stated["anchor"]) == ("res-1", "highlighting", "0:12:Ada Lovelace")
    assert "body" not in stated
    page = "Ada Lovelace\nwrote the first algorithm.\n"
    did = agent_did("example.org", "ollama", "gemma3:4b")
    job: JsonObject = {
        "status": "running",
        "metadata": {
            "id": "job-1",
            "type": "mark",
            "userId": "did:web:kb.example:users:u",
            "created": "2026-01-01T00:00:00.000Z",
            "retryCount": 0,
            "maxRetries": 1,
        },
        "params": {"resourceId": "res-1", "motivation": "highlighting"},
        "startedAt": "2026-01-01T00:00:01.000Z",
        "progress": {},
    }

    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            gateway.answers[TOKEN] = {"access_token": token(3600, 0)}
            gateway.scripted[("POST", AGENT)] = [agent_token(1)]
            # Who the gateway says the agent's token is.
            gateway.answers[ME] = {
                "did": did,
                "email": agent_address("example.org", "ollama", "gemma3:4b"),
                "name": "ollama gemma3:4b",
                "image": None,
                "domain": "example.org",
            }
            gateway.stored["res-1"] = ("text/plain", page.encode())
            # The dispatcher: the first claim is handed a job, the second is refused, and no other is answered.
            answers: list[tuple[str, JsonObject]] = [
                ("job:claimed", {"response": job}),
                ("job:claim-failed", {"code": "rejected", "message": "the queue is being moved"}),
            ]

            def dispatching(emit: JsonObject) -> None:
                if emit["channel"] == "job:claim" and answers:
                    channel, payload = answers.pop(0)
                    gateway.send(None, {"channel": channel, "payload": payload, "correlationId": emit["correlationId"]})
                elif emit["channel"] == "mark:commit":
                    # The record: it has the batch, and says so.
                    batch = emit["payload"]
                    assert isinstance(batch, dict)
                    ids = [annotation["id"] for annotation in objects(batch["annotations"], "the batch's annotations")]
                    held: JsonObject = {"response": {"persisted": len(ids), "annotationIds": ids}}
                    gateway.send(None, {"channel": "mark:commit-ok", "payload": held, "correlationId": emit["correlationId"]})

            gateway.on_emit = dispatching
            working = asyncio.ensure_future(a_worker.work(gateway.origin, issuer_of(gateway), "my-worker", SECRET))

            def said() -> list[str]:
                return [str(emit["channel"]) for emit in gateway.emits]

            # Settling the job is an idle moment, and so the next claim: the one that is refused.
            await until("the worker's second claim", lambda: said().count("job:claim") == 2)
            await settle()
            assert said() == ["job:claim", "job:start", "job:report-progress", "mark:commit", "job:complete", "job:claim"]
            claim, start, progress, commit, complete, _ = gateway.emits
            assert claim["payload"] == {"accepts": [{"jobType": "mark", "params": {"motivation": "highlighting"}}]}
            # Every message of the lifecycle names the job and the attempt it is.
            identity: JsonObject = {"resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "attempt": 1}
            assert start["payload"] == identity
            assert progress["payload"] == {**identity, "percentage": 50, "progress": {"percentage": 50}}
            # It commits the one highlight, for the job: of the first line, as the text has it, made by the agent it works as.
            batch = commit["payload"]
            assert isinstance(batch, dict)
            assert (batch["resourceId"], batch["jobId"]) == ("res-1", "job-1")
            (highlight,) = objects(batch["annotations"], "the batch's annotations")
            assert (highlight["id"], highlight["motivation"]) == (stated["id"], "highlighting")
            assert highlight["generator"] == {
                "@type": "Software",
                "@id": did,
                "name": "ollama gemma3:4b",
                "provider": "ollama",
                "model": "gemma3:4b",
            }
            target = highlight["target"]
            assert isinstance(target, dict)
            assert target["source"] == "res-1"
            assert target["selector"] == [
                {"type": "TextPositionSelector", "start": 0, "end": 12},
                {"type": "TextQuoteSelector", "exact": "Ada Lovelace", "suffix": "\nwrote the first algorithm.\n"},
            ]
            # And it reports what it proposed and what the record holds, established by the record's acknowledgement.
            assert complete["payload"] == {**identity, "result": {"found": 1, "persisted": 1}, "durability": "acknowledged"}
            # It works as the agent, on a stream that names what claiming and committing read and nothing else.
            (exchanged,) = gateway.of("POST", AGENT)
            assert exchanged.json() == {"provider": "ollama", "model": "gemma3:4b"}
            (subscribed,) = gateway.of("POST", "/bus/subscribe")
            assert subscribed.headers["authorization"] != exchanged.headers["authorization"]
            assert subscribed.json()["global"] == [*JOB_CLAIM_CHANNELS, *JOB_COMMIT_CHANNELS]

            # Stopped while it holds nothing, it says nothing more.
            assert not working.done()
            working.cancel()
            await asyncio.gather(working, return_exceptions=True)
            assert said().count("job:fail") == 0

    run(scenario())
    assert capsys.readouterr().out.splitlines() == ["claim refused: the queue is being moved"]


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


def test_building_annotations_builds_a_highlight_of_a_text_and_of_a_pdf_and_a_link_and_reads_each() -> None:
    generator = AgentSoftware(type="Software", name="ollama gemma3:4b")
    text = "Ada Lovelace\nwrote the first algorithm.\n"

    # The model wrote the name in small letters: the highlight quotes it as the text has it.
    highlight = building_annotations.highlight(text, QuotedText(exact="ada lovelace"), RESOURCE, generator)
    assert highlight is not None
    assert building_annotations.describe(highlight) == f"{highlight.id}: a highlight of 'Ada Lovelace' in res-1"
    # Built again, it is the same annotation: its id is of what it is.
    again = building_annotations.highlight(text, QuotedText(exact="Ada Lovelace"), RESOURCE, generator)
    assert again is not None
    assert again.id == highlight.id
    # Words the text does not have are no highlight.
    assert building_annotations.highlight(text, QuotedText(exact="Grace Hopper"), RESOURCE, generator) is None

    anchored = AnchoredText(
        text=text,
        items=[
            PdfTextItem(start=0, end=3, page=1, x=72, y=720, width=18, height=12),
            PdfTextItem(start=4, end=12, page=1, x=94, y=720, width=48, height=12),
        ],
    )
    of_a_pdf = building_annotations.highlight_of_a_pdf(anchored, QuotedText(exact="Ada Lovelace"), RESOURCE, generator)
    assert of_a_pdf is not None
    assert building_annotations.describe(of_a_pdf) == f"{of_a_pdf.id}: a highlight of 'Ada Lovelace' in res-1"
    # One line of the page, so one rectangle: from the first item's left edge to the second's right.
    selector = target_selector(of_a_pdf.target)
    assert isinstance(selector, list)
    assert [item.value for item in selector if isinstance(item, FragmentSelector)] == ["page=1&viewrect=72,720,70,12"]

    link = building_annotations.link_to_what_was_generated(RESOURCE, ResourceId("res-2"), generator)
    assert building_annotations.describe(link) == f"{link.id}: linking, from res-1 to res-2"
    assert target_selector(link.target) is None
