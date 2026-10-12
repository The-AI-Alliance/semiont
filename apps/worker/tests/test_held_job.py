"""One held job from its claim to its settle: what the service does around a processor.

`docs/protocol/WORKER-SERVICE.md` states it rule by rule, and the worker
service's conformance suite holds a started service to those rules. Here is
what that suite cannot reach, or cannot make happen: a report the gateway is
slow to take, or does not take; a settle the gateway does not take; a worker
told to stop while its model is silent; and a `yield` job to PDF, whose
citations are anchored in the text the Smelter reads back.

Each job is handed over by a real claim, over the SDK's doubles
(`holding.py`).
"""

import asyncio
import logging
from collections.abc import Mapping
from typing import Final

import pytest
from aio import run, turns
from holding import EVERY_JOB, SOURCE, TEXT, Parties, answering, claimed, job, worked
from pydantic import JsonValue
from semiont.errors import TransportError
from semiont.identifiers import ResourceId
from semiont.testing import ContentCall, GetAnchoredText, GetBinary, PutBinary
from semiont.timing import GENERATED_TEXT_ASKS_COUNT
from semiont.transport import Frame
from semiont.types import AnchoredTextAbsent, AnchoredTextAnswer, ExtractedText, ExtractionDeclined, GenerationJobParams, JobProgress
from semiont.watched import Watched
from semiont_inference.interface import ElementSchema, InferenceClient, InferenceLimits, InferenceResponse, StructuredResponse
from standing_in import GENERATOR

from semiont_worker import held_job
from semiont_worker.generation.citations import GenerationCitation
from semiont_worker.held_job import run_job
from semiont_worker.processors import Cancelled, GeneratedArtifact, OnProgress

HIGHLIGHTING: Final[dict[str, JsonValue]] = {"motivation": "highlighting"}
ONE_HIGHLIGHT: Final = '[{"exact": "the first program"}]'


def channels_sent(parties: Parties) -> list[str]:
    return [frame.channel for frame in parties.frames()]


def logged(caplog: pytest.LogCaptureFixture, message: str) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_worker" and record.getMessage().startswith(message)]


# ── a mark job ──────────────────────────────────────────────────────────


def test_a_mark_job_is_started_read_committed_checkpointed_and_completed_in_that_order() -> None:
    parties = Parties()
    parties.text_resource()
    run(worked(parties, job("job-1", "mark", HIGHLIGHTING), answering(ONE_HIGHLIGHT)))

    assert parties.sequence() == ["job:start", "browse:resource-requested", "mark:commit", "job:checkpoint", "job:complete"]
    (completion,) = parties.sent("job:complete")
    assert completion == {
        "resourceId": SOURCE,
        "jobId": "job-1",
        "jobType": "mark",
        "attempt": 1,
        "result": {"found": 1, "persisted": 1},
        "durability": "acknowledged",
    }
    ((resource, annotations),) = parties.commits
    assert resource == SOURCE
    assert len(annotations) == 1
    # Every report was sent, and each before the job was settled.
    sent = channels_sent(parties)
    assert sent.count("job:report-progress") == 4
    assert max(at for at, channel in enumerate(sent) if channel == "job:report-progress") < sent.index("job:complete")


def test_a_job_goes_on_without_waiting_for_a_report_to_be_taken_and_is_not_settled_until_every_one_is(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        taking = asyncio.Event()
        emit = parties.transport.emit
        held_up: list[str] = []

        async def slow_to_take_a_report(
            channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
        ) -> int | None:
            if channel == "job:report-progress":
                held_up.append(channel)
                await taking.wait()
            return await emit(channel, payload, scope=scope, correlation_id=correlation_id)

        monkeypatch.setattr(parties.transport, "emit", slow_to_take_a_report)
        working = asyncio.ensure_future(worked(parties, job("job-1", "mark", HIGHLIGHTING), answering(ONE_HIGHLIGHT)))
        for _ in range(20):
            await turns()

        # No report has been taken, and the job has gone on all the same: it has committed its piece and said where that leaves it.
        assert len(held_up) == 4
        assert parties.sequence() == ["job:start", "browse:resource-requested", "mark:commit", "job:checkpoint"]
        # It is not settled while a report is still on its way.
        assert not working.done()
        assert parties.sent("job:complete") == []

        taking.set()
        await working
        sent = channels_sent(parties)
        assert sent.count("job:report-progress") == 4
        assert sent.index("job:complete") > max(at for at, channel in enumerate(sent) if channel == "job:report-progress")

    run(scenario())


def test_a_report_the_gateway_does_not_take_fails_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    parties = Parties()
    parties.text_resource()
    emit = parties.transport.emit

    async def refusing_reports(
        channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        if channel == "job:report-progress":
            raise TransportError.of_status("/bus/emit 503: not now", 503, None)
        return await emit(channel, payload, scope=scope, correlation_id=correlation_id)

    monkeypatch.setattr(parties.transport, "emit", refusing_reports)
    run(worked(parties, job("job-1", "mark", HIGHLIGHTING), answering(ONE_HIGHLIGHT)))
    assert parties.sequence() == ["job:start", "browse:resource-requested", "mark:commit", "job:checkpoint", "job:complete"]
    assert parties.sent("job:fail") == []


def test_a_completion_the_gateway_did_not_take_is_said_in_the_log_and_is_not_followed_by_a_failure(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    parties = Parties()
    parties.text_resource()
    emit = parties.transport.emit

    async def refusing_the_completion(
        channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        if channel == "job:complete":
            raise TransportError.of_status("/bus/emit 400: refused", 400, None)
        return await emit(channel, payload, scope=scope, correlation_id=correlation_id)

    monkeypatch.setattr(parties.transport, "emit", refusing_the_completion)
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, job("job-1", "mark", HIGHLIGHTING), answering(ONE_HIGHLIGHT)))

    # The settle released the job when it was asked for: there is nothing more the worker can say of it.
    assert parties.sent("job:fail") == []
    (failed,) = logged(caplog, "Job failed")
    assert (failed.levelname, vars(failed)["jobId"], vars(failed)["error"]) == ("ERROR", "job-1", "/bus/emit 400: refused")
    assert logged(caplog, "Job failure could not be reported") == []


def test_a_failure_the_gateway_does_not_take_is_said_in_the_log_and_ends_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    parties = Parties()
    # The record does not have the resource: the job fails once it has started.
    emit = parties.transport.emit

    async def refusing_the_failure(
        channel: str, payload: Mapping[str, JsonValue], *, scope: ResourceId | None = None, correlation_id: str | None = None
    ) -> int | None:
        if channel == "job:fail":
            raise TransportError.without_response("/bus/emit got no answer")
        return await emit(channel, payload, scope=scope, correlation_id=correlation_id)

    monkeypatch.setattr(parties.transport, "emit", refusing_the_failure)
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, job("job-1", "mark", HIGHLIGHTING), answering(ONE_HIGHLIGHT)))

    assert parties.sequence() == ["job:start", "browse:resource-requested"]
    (failed,) = logged(caplog, "Job failed")
    assert vars(failed)["error"] == f"Resource not found: {SOURCE}"
    assert vars(failed)["failureClass"] is None
    (unsaid,) = logged(caplog, "Job failure could not be reported")
    assert (unsaid.levelname, vars(unsaid)["jobId"], vars(unsaid)["error"]) == ("ERROR", "job-1", "/bus/emit got no answer")


def test_a_failure_is_said_with_its_class_and_the_stack_it_was_raised_from_is_in_the_log(caplog: pytest.LogCaptureFixture) -> None:
    parties = Parties()
    parties.describe(SOURCE, "image/png")
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, job("job-1", "mark", {"motivation": "commenting"}), answering("[]")))

    (failure,) = parties.sent("job:fail")
    error = failure["error"]
    assert isinstance(error, str)
    assert {name: said for name, said in failure.items() if name != "error"} == {
        "resourceId": SOURCE,
        "jobId": "job-1",
        "jobType": "mark",
        "attempt": 1,
        "failureClass": "deterministic",
        "willRetry": False,
    }
    (failed,) = logged(caplog, "Job failed")
    assert (vars(failed)["error"], vars(failed)["failureClass"]) == (error, "deterministic")
    assert failed.exc_info is not None
    assert failed.exc_info[0] is not None
    assert failed.exc_info[0].__name__ == "DeterministicJobError"


def test_a_resource_whose_description_states_no_representation_has_no_text_to_read_and_its_job_fails_for_good() -> None:
    parties = Parties()
    parties.descriptors[SOURCE] = {"@context": "https://schema.org", "@id": SOURCE, "name": "A resource", "representations": []}
    run(worked(parties, job("job-1", "mark", HIGHLIGHTING), answering(ONE_HIGHLIGHT)))

    assert parties.sequence() == ["job:start", "browse:resource-requested", "job:fail"]
    (failure,) = parties.sent("job:fail")
    assert (failure["failureClass"], failure["willRetry"]) == ("deterministic", False)
    assert failure["error"] == (
        f"Cannot run mark (highlighting) on resource {SOURCE}: media type 'unknown' has no extractable text to analyze"
    )
    # No bytes were read.
    assert parties.content.calls == []


class Silent:
    """A model that is asked and never answers, until its test lets it."""

    def __init__(self) -> None:
        self.provider: Final = "mock"
        self.model_id: Final = "mock-model"
        self.max_concurrency: Final = 1
        self.verify_detection_yield: Final = False
        self.asked: Final = asyncio.Event()
        self.answer: Final = asyncio.Event()

    async def limits(self) -> InferenceLimits:
        return InferenceLimits(context_tokens=8192, max_output_tokens=8192, output_tokens_per_hour=None, accepts_temperature=True)

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        self.asked.set()
        await self.answer.wait()
        return InferenceResponse(text="A document.", stop_reason="end_turn", usage=None)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        self.asked.set()
        await self.answer.wait()
        return StructuredResponse(items=[], stop_reason="end_turn", usage=None)


def test_a_job_its_worker_s_stopping_failed_is_left_as_it_is_and_its_work_ends_with_its_worker() -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.queue.append(job("job-1", "mark", HIGHLIGHTING))
        model: InferenceClient = (silent := Silent())
        async with parties.client as client:
            claims = client.job.claim(EVERY_JOB)
            held = await claimed(parties, claims)
            working = asyncio.ensure_future(run_job(held, client=client, inference=model, generator=GENERATOR, accepts=EVERY_JOB))
            await asyncio.wait_for(silent.asked.wait(), 5)

            # The worker is told to stop while its model is silent: the job is failed first, by the claiming.
            await claims.aclose()
            (failure,) = parties.sent("job:fail")
            assert failure == {
                "resourceId": SOURCE,
                "jobId": "job-1",
                "jobType": "mark",
                "attempt": 1,
                "error": "The worker stopped while it held the job",
                "willRetry": True,
            }
            said = len(parties.frames())

            # The work is then ended. It says nothing more of a job that is settled, and its ending is its worker's, not its own.
            working.cancel()
            with pytest.raises(asyncio.CancelledError):
                await working
            await turns()
            assert len(parties.frames()) == said
        await parties.transport.close()

    run(scenario())


def test_a_cancellation_that_names_the_held_job_is_said_in_the_log_and_the_job_is_settled_as_cancelled(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        parties = Parties()
        parties.text_resource()
        parties.queue.append(job("job-1", "mark", HIGHLIGHTING))
        model: InferenceClient = (silent := Silent())
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            held = await claimed(parties, claims)
            working = asyncio.ensure_future(run_job(held, client=client, inference=model, generator=GENERATOR, accepts=EVERY_JOB))
            await asyncio.wait_for(silent.asked.wait(), 5)

            # A cancellation of another job is not this one's, and one that names it is.
            parties.transport.deliver(Frame(channel="job:cancel-requested", payload={"jobId": "job-other"}))
            await turns()
            assert logged(caplog, "Cancel requested for active job") == []
            parties.transport.deliver(Frame(channel="job:cancel-requested", payload={"jobId": "job-1"}))
            await turns()
            (noted,) = logged(caplog, "Cancel requested for active job")
            assert (noted.levelname, vars(noted)["jobId"]) == ("INFO", "job-1")
            # Nothing is ended: the model is still asked, and the job stops once it has answered.
            assert not working.done()
            silent.answer.set()
            await asyncio.wait_for(working, 5)
            assert parties.sent("job:cancel") == [
                {"resourceId": SOURCE, "jobId": "job-1", "jobType": "mark", "completedUnits": ["highlighting"]}
            ]
            assert parties.sent("job:complete") == []
            await turns()
        await parties.transport.close()

    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(scenario())


# ── a yield job ─────────────────────────────────────────────────────────

SOURCE_DESCRIPTOR: Final[JsonValue] = {"@context": "https://schema.org", "@id": SOURCE, "name": "Source Doc", "representations": []}
CONTEXT: Final[JsonValue] = {
    "focus": {"kind": "resource", "resource": SOURCE_DESCRIPTOR},
    "graph": {
        "nodes": [{"id": SOURCE, "type": "resource", "label": "Source Doc"}, {"id": "ctx-9", "type": "resource", "label": "Context Doc"}],
        "edges": [],
    },
    "metadata": {},
}

NEW: Final = "test-content-1"
"""The id the content double gives the first resource uploaded to it."""


def generation(storage_uri: str = "file://generated/out.md", **stated: JsonValue) -> dict[str, JsonValue]:
    return job("job-y", "yield", {"title": "Generated", "storageUri": storage_uri, "context": CONTEXT, **stated})


def making(monkeypatch: pytest.MonkeyPatch, artifact: GeneratedArtifact | Cancelled) -> list[GenerationJobParams]:
    """Stand in for the generation: the processor answers `artifact`, having reported once. Answers what it was asked with."""
    asked: list[GenerationJobParams] = []

    async def process_generation_job(
        client: InferenceClient, params: GenerationJobParams, *, on_progress: OnProgress, cancelled: Watched[bool]
    ) -> GeneratedArtifact | Cancelled:
        asked.append(params)
        on_progress(JobProgress.model_validate({"percentage": 5, "message": {"code": "generating-resource"}}))
        return artifact

    monkeypatch.setattr(held_job, "process_generation_job", process_generation_job)
    return asked


def markdown(text: str = "A document.") -> GeneratedArtifact:
    return GeneratedArtifact(content=text.encode("utf-8"), title="Generated", format="text/markdown", citations=[], truncated=False)


def test_a_yield_job_uploads_what_was_made_links_its_source_to_it_and_completes_with_the_new_resource(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parties = Parties()
    asked = making(monkeypatch, markdown())
    run(worked(parties, generation(), answering("unused")))

    assert [params.title for params in asked] == ["Generated"]
    assert parties.sequence() == ["job:start", "mark:commit", "job:complete"]
    (completion,) = parties.sent("job:complete")
    assert completion["result"] == {"resourceId": NEW, "resourceName": "Generated", "truncated": False}
    # One annotation, on the source, that points at what was made. The citations are none, and no batch of none is sent.
    ((resource, annotations),) = parties.commits
    assert resource == SOURCE
    (link,) = annotations
    assert isinstance(link, dict)
    assert (link["motivation"], link["target"], link["body"]) == (
        "linking",
        {"source": SOURCE},
        {"type": "SpecificResource", "source": NEW, "purpose": "linking"},
    )


def test_a_location_whose_extension_is_not_the_format_s_is_written_as_asked_and_said_in_the_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    parties = Parties()
    making(monkeypatch, markdown())
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, generation("file://generated/out.txt"), answering("unused")))

    (warned,) = logged(caplog, "Storage URI extension does not match the generated format")
    assert warned.levelname == "WARNING"
    assert (vars(warned)["storageUri"], vars(warned)["format"], vars(warned)["expectedExtension"]) == (
        "file://generated/out.txt",
        "text/markdown",
        ".md",
    )
    # Written where it was asked for, all the same.
    (upload,) = parties.content.calls
    assert isinstance(upload, PutBinary)
    assert (upload.request.storage_uri, upload.request.format) == ("file://generated/out.txt", "text/markdown")
    assert len(parties.sent("job:complete")) == 1


def test_a_location_whose_extension_is_the_format_s_in_any_case_says_nothing(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    parties = Parties()
    making(monkeypatch, markdown())
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, generation("file://generated/OUT.MD"), answering("unused")))
    assert logged(caplog, "Storage URI extension") == []
    assert len(parties.sent("job:complete")) == 1


def test_params_that_are_no_generation_s_fail_the_job_with_no_class_before_anything_is_made(monkeypatch: pytest.MonkeyPatch) -> None:
    parties = Parties()
    asked = making(monkeypatch, markdown())
    # No title, and nowhere to store it.
    run(worked(parties, job("job-y", "yield", {"context": CONTEXT}), answering("unused")))

    assert asked == []
    assert parties.sequence() == ["job:start", "job:fail"]
    (failure,) = parties.sent("job:fail")
    error = failure["error"]
    assert isinstance(error, str)
    assert error.startswith("generation job job-y: params do not satisfy GenerationJobParams (")
    assert "title" in error
    assert "storageUri" in error
    assert "failureClass" not in failure
    assert failure["willRetry"] is True
    assert parties.content.calls == []


def test_a_job_that_says_nowhere_to_store_what_it_makes_fails_and_writes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    # Where the artifact is stored is the job's to say. There is no other place it is written: no location is made from its title.
    parties = Parties()
    asked = making(monkeypatch, markdown())
    run(worked(parties, generation(""), answering("unused")))
    assert asked == []
    (failure,) = parties.sent("job:fail")
    error = failure["error"]
    assert isinstance(error, str)
    assert "storageUri" in error
    assert parties.content.calls == []
    assert parties.commits == []


def test_a_yield_job_cancelled_by_the_time_its_model_answered_uploads_nothing_and_is_settled_as_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parties = Parties()
    making(monkeypatch, Cancelled(completed_units=[]))
    run(worked(parties, generation(), answering("unused")))
    assert parties.sequence() == ["job:start", "job:cancel"]
    assert parties.sent("job:cancel") == [{"resourceId": SOURCE, "jobId": "job-y", "jobType": "yield"}]
    assert parties.content.calls == []
    assert parties.commits == []


# ── the citations of a generated PDF ────────────────────────────────────

RENDERED: Final = "It is extraor \ndinarily complicated today. Nothing else is said."
"""A PDF's text as the Smelter reads it back: a line is broken inside a word, which has lost its hyphen."""

ITEMS: Final[list[JsonValue]] = [
    {"start": 0, "end": 15, "page": 1, "x": 72, "y": 700, "width": 300, "height": 12},
    {"start": 15, "end": 42, "page": 1, "x": 72, "y": 680, "width": 270, "height": 12},
    {"start": 42, "end": 64, "page": 1, "x": 342, "y": 680, "width": 220, "height": 12},
]
EXTRACTED: Final = ExtractedText.model_validate({"kind": "extracted", "method": "pdf-text-layer", "text": RENDERED, "items": ITEMS})
NOT_YET: Final = AnchoredTextAbsent(kind="not-yet")

ASKED: Final = GetAnchoredText(ResourceId(NEW))
"""One ask for the text of the resource the job made."""


def cited(exact: str, resource: str = "ctx-9") -> GenerationCitation:
    # A PDF's citation states offsets into its Typst source, which say nothing of where the claim is in the PDF.
    return GenerationCitation(resource_id=ResourceId(resource), annotation_id=None, start=1000, end=1000 + len(exact), exact=exact)


def pdf(*citations: GenerationCitation) -> GeneratedArtifact:
    return GeneratedArtifact(
        content=b"%PDF-1.7 a stand-in", title="Generated", format="application/pdf", citations=list(citations), truncated=False
    )


def citations_committed(parties: Parties) -> list[JsonValue]:
    """The annotations committed on the new resource: its citations."""
    return [annotation for resource, annotations in parties.commits if resource == NEW for annotation in annotations]


def pdf_text(parties: Parties, answer: AnchoredTextAnswer) -> None:
    """Have the gateway answer `answer` when it is asked for the text of the resource the job will make."""
    parties.content.seed_anchored_text(ResourceId(NEW), answer)


def text_asks(parties: Parties) -> list[ContentCall]:
    """What the worker read of the gateway once it had uploaded what it made."""
    upload, *reads = parties.content.calls
    assert isinstance(upload, PutBinary)
    return reads


def test_a_pdf_s_citation_is_anchored_where_the_claim_is_on_the_page_and_quotes_the_text_as_the_pdf_has_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parties = Parties()
    pdf_text(parties, EXTRACTED)
    making(monkeypatch, pdf(cited("extraordinarily complicated")))
    run(worked(parties, generation("file://generated/out.pdf", outputMediaType="application/pdf"), answering("unused")))

    # The text was asked for once, of the new resource, and no bytes were read back.
    assert text_asks(parties) == [ASKED]
    (citation,) = citations_committed(parties)
    assert isinstance(citation, dict)
    assert (citation["motivation"], citation["body"]) == ("linking", {"type": "SpecificResource", "source": "ctx-9", "purpose": "linking"})
    target = citation["target"]
    assert isinstance(target, dict)
    assert target["source"] == NEW
    selectors = target["selector"]
    assert isinstance(selectors, list)
    # A rectangle for each of the two lines the claim is on, and then its quote: no offset into anything.
    assert [selector["type"] for selector in selectors if isinstance(selector, dict)] == [
        "FragmentSelector",
        "FragmentSelector",
        "TextQuoteSelector",
    ]
    quote = selectors[-1]
    assert isinstance(quote, dict)
    # The words under the rectangles: the claim as the PDF has it, broken where its line is and without its hyphen.
    assert quote["exact"] == "extraor \ndinarily complicated"
    assert RENDERED[6:35] == "extraor \ndinarily complicated"
    # The text is read of the gateway and not asked for on the bus: what the worker sent there is its two commits.
    assert parties.sequence() == ["job:start", "mark:commit", "mark:commit", "job:complete"]


def test_a_claim_the_pdf_s_text_does_not_have_is_dropped_and_said_in_the_log_and_the_others_are_kept(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    parties = Parties()
    pdf_text(parties, EXTRACTED)
    making(monkeypatch, pdf(cited("a claim that was never rendered"), cited("Nothing else is said.", SOURCE)))
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, generation("file://generated/out.pdf", outputMediaType="application/pdf"), answering("unused")))

    (kept,) = citations_committed(parties)
    assert isinstance(kept, dict)
    assert kept["body"] == {"type": "SpecificResource", "source": SOURCE, "purpose": "linking"}
    (dropped,) = logged(caplog, "PDF citation dropped")
    assert dropped.levelname == "WARNING"
    assert (vars(dropped)["resourceId"], vars(dropped)["citedResourceId"], vars(dropped)["exactPreview"]) == (
        NEW,
        "ctx-9",
        "a claim that was never rendered",
    )
    assert len(parties.sent("job:complete")) == 1


def test_a_pdf_whose_text_is_not_there_yet_is_asked_for_again_and_each_further_ask_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    parties = Parties()
    pdf_text(parties, NOT_YET)
    read = parties.content.get_anchored_text

    async def there_at_the_third_ask(resource_id: ResourceId) -> AnchoredTextAnswer:
        # The Smelter settles the resource between the second ask and the third.
        if len(text_asks(parties)) == 2:
            pdf_text(parties, EXTRACTED)
        return await read(resource_id)

    monkeypatch.setattr(parties.content, "get_anchored_text", there_at_the_third_ask)
    making(monkeypatch, pdf(cited("extraordinarily complicated")))
    run(worked(parties, generation("file://generated/out.pdf", outputMediaType="application/pdf"), answering("unused")))

    assert text_asks(parties) == [ASKED] * 3
    assert len(citations_committed(parties)) == 1
    # What the job last said is said again before each further ask: a long silence reads as a stall.
    waits = [
        report["progress"]
        for report in parties.sent("job:report-progress")
        if isinstance(progress := report["progress"], dict) and progress.get("percentage") == 100
    ]
    assert waits == [{"percentage": 100, "message": {"code": "complete-generated", "truncated": False}}] * 2


def test_a_pdf_whose_text_never_arrives_completes_with_its_resource_and_without_its_citations_and_says_so(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    parties = Parties()
    pdf_text(parties, NOT_YET)
    making(monkeypatch, pdf(cited("extraordinarily complicated"), cited("Nothing else is said.")))
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, generation("file://generated/out.pdf", outputMediaType="application/pdf"), answering("unused")))

    # Asked as many times as the timing table states, and no more.
    assert text_asks(parties) == [ASKED] * GENERATED_TEXT_ASKS_COUNT
    assert citations_committed(parties) == []
    (completion,) = parties.sent("job:complete")
    assert completion["result"] == {"resourceId": NEW, "resourceName": "Generated", "truncated": False}
    assert parties.sent("job:fail") == []
    (dropped,) = logged(caplog, "PDF citations dropped")
    assert (dropped.levelname, vars(dropped)["resourceId"], vars(dropped)["citations"], vars(dropped)["reason"]) == (
        "WARNING",
        NEW,
        2,
        "not-yet",
    )


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        (ExtractionDeclined(kind="declined", declined="too-large"), "too-large"),
        (AnchoredTextAbsent(kind="no-map"), "no-map"),
        (AnchoredTextAbsent(kind="unknown"), "unknown"),
    ],
)
def test_a_pdf_whose_text_is_not_to_be_had_is_asked_for_once_and_its_citations_are_dropped_with_the_reason(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, answer: AnchoredTextAnswer, reason: str
) -> None:
    parties = Parties()
    pdf_text(parties, answer)
    making(monkeypatch, pdf(cited("extraordinarily complicated")))
    caplog.set_level(logging.INFO, logger="semiont_worker")
    run(worked(parties, generation("file://generated/out.pdf", outputMediaType="application/pdf"), answering("unused")))

    assert text_asks(parties) == [ASKED]
    assert citations_committed(parties) == []
    assert len(parties.sent("job:complete")) == 1
    (dropped,) = logged(caplog, "PDF citations dropped")
    assert vars(dropped)["reason"] == reason


def test_the_text_of_a_pdf_that_cites_nothing_is_not_asked_for(monkeypatch: pytest.MonkeyPatch) -> None:
    parties = Parties()
    making(monkeypatch, pdf())
    run(worked(parties, generation("file://generated/out.pdf", outputMediaType="application/pdf"), answering("unused")))
    assert text_asks(parties) == []
    assert parties.sequence() == ["job:start", "mark:commit", "job:complete"]


def test_the_text_a_mark_job_reads_is_the_resource_s_own() -> None:
    # The resource's bytes are read by the client's own call, on the gateway, naming the resource.
    parties = Parties()
    parties.text_resource()
    model = answering(ONE_HIGHLIGHT)
    run(worked(parties, job("job-1", "mark", HIGHLIGHTING), model))
    assert parties.content.calls == [GetBinary(ResourceId(SOURCE))]
    assert TEXT.strip() in model.calls[0].prompt


def test_a_pdf_whose_text_the_gateway_cannot_give_fails_its_job_as_any_refused_read_does_to_be_tried_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    parties = Parties()
    parties.describe(SOURCE, "application/pdf")

    async def refused(resource_id: ResourceId) -> AnchoredTextAnswer:
        raise TransportError.of_status("The Archivist cannot be reached", 503, None)

    monkeypatch.setattr(parties.content, "get_anchored_text", refused)
    run(worked(parties, job("job-1", "mark", HIGHLIGHTING), answering(ONE_HIGHLIGHT)))

    assert parties.sequence() == ["job:start", "browse:resource-requested", "job:fail"]
    (failure,) = parties.sent("job:fail")
    # Classed by the status the gateway refused the read with, as a refused read of a resource's bytes is.
    assert (failure["error"], failure["failureClass"], failure["willRetry"]) == ("The Archivist cannot be reached", "transient", True)
