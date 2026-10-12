"""The `yield` processor: what it asks for, what it makes of the answer, what it reports, and what it refuses.

`docs/protocol/WORKER-SERVICE.md` § Generation states what a `yield` job
does, and each test here that holds one of its rules names the rule. The
generation and the compiler are stood in for (`standing_in.py`): what a
prompt says and how a model is asked are `test_generation_prompts.py`'s and
`test_resource_generation.py`'s to hold, and how the compiler is run is
`test_typst.py`'s. The citations are resolved for real. What a cancellation
does to a generation is `test_cancellation.py`'s.
"""

import logging
from typing import Annotated, Final

import pytest
from aio import run
from pydantic import BaseModel, Field, JsonValue
from semiont.identifiers import ResourceId
from semiont.types import GenerationJobParams
from spec import SPEC
from standing_in import AskedToGenerate, Handed, compiler_stood_in, generation_stood_in, report

from semiont_worker.failure_class import DeterministicJobError, classify_failure
from semiont_worker.generation.citations import GenerationCitation
from semiont_worker.generation.resource_generation import GeneratedDocument, Repair
from semiont_worker.generation.typst import MAX_COMPILE_REPAIRS, Compiled, NotCompiled
from semiont_worker.processors import MAX_OUTPUT_BYTES, Cancelled, GeneratedArtifact, assert_within_output_budget, process_generation_job

SOURCE: Final[JsonValue] = {"@context": "https://schema.org", "@id": "src-1", "name": "Source Doc", "representations": []}
CONTEXT: Final[JsonValue] = {
    "focus": {"kind": "resource", "resource": SOURCE},
    # What the context showed the model: the source, and one resource beside it.
    "graph": {
        "nodes": [{"id": "src-1", "type": "resource", "label": "Source Doc"}, {"id": "ctx-9", "type": "resource", "label": "Context Doc"}],
        "edges": [],
    },
    "metadata": {},
}


class LargestPdf(BaseModel, frozen=True, extra="ignore", strict=True):
    """The most bytes a Smelter reads of a PDF, as `specs/src/smelter/extraction-cases.json` states it: all the worker reads there."""

    largest_pdf_bytes: Annotated[int, Field(alias="largestPdfBytes")]


GENERATING: Final = report(5, {"code": "generating-resource"}, {})
CREATING: Final = report(95, {"code": "creating-resource"}, {})


def complete(truncated: bool) -> JsonValue:
    return report(100, {"code": "complete-generated", "truncated": truncated}, {})


def job(stated: dict[str, JsonValue]) -> GenerationJobParams:
    """A `yield` job about the resource `src-1`, stating what `stated` says beside the three every job states."""
    return GenerationJobParams.model_validate({"title": "Generated", "storageUri": "file://generated/out.md", "context": CONTEXT, **stated})


def writing(content: str, truncated: bool) -> "list[GeneratedDocument]":
    """What a model is to have written, for a stand-in that answers every call the same."""
    return [GeneratedDocument(content=content, truncated=truncated)]


def generate(handed: Handed, params: GenerationJobParams) -> GeneratedArtifact | Cancelled:
    return run(process_generation_job(handed.client, params, on_progress=handed.told, cancelled=handed.cancelled))


def made(outcome: GeneratedArtifact | Cancelled) -> GeneratedArtifact:
    """What a generation that ran to its end made. One a cancellation stopped made nothing, and fails the test that did not expect it."""
    assert isinstance(outcome, GeneratedArtifact), "the generation was stopped by a cancellation"
    return outcome


def answering(monkeypatch: pytest.MonkeyPatch, *documents: GeneratedDocument) -> list[AskedToGenerate]:
    """Stand in for the generation: each call is answered the next of `documents`, and the last of them from then on."""
    asked: list[AskedToGenerate] = []

    def answer(call: AskedToGenerate) -> GeneratedDocument:
        asked.append(call)
        return documents[min(len(asked), len(documents)) - 1]

    generation_stood_in(monkeypatch, answer)
    return asked


def whole(content: str) -> GeneratedDocument:
    return GeneratedDocument(content=content, truncated=False)


def cut_off(content: str) -> GeneratedDocument:
    return GeneratedDocument(content=content, truncated=True)


# ── a text format ───────────────────────────────────────────────────────


def test_a_generation_asks_once_for_the_job_as_it_is_and_answers_the_document_as_bytes_under_the_job_s_title(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked = answering(monkeypatch, whole("# Café\n\nBody."))
    handed = Handed(1)
    params = job({"title": "Initial", "entityTypes": [], "language": "de", "sourceLanguage": "fr"})

    artifact = made(generate(handed, params))

    # Y2: one request. The job is handed on whole, with the format it writes and the provider it was claimed for.
    assert asked == [AskedToGenerate(params, "text/markdown", handed.client, None)]
    # Y1: with no format stated, the job writes Markdown. The artifact is bytes, whatever its format: UTF-8, of a text.
    assert artifact == GeneratedArtifact(
        content=b"# Caf\xc3\xa9\n\nBody.", title="Initial", format="text/markdown", citations=[], truncated=False
    )
    # Y8.
    assert handed.told.said() == [GENERATING, CREATING, complete(False)]


def test_a_document_the_model_was_cut_off_in_is_kept_and_said_to_be_truncated_on_the_report_and_on_the_artifact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Y3 and Y8.
    answering(monkeypatch, cut_off("Cut off mid-sen"))
    handed = Handed(1)

    artifact = made(generate(handed, job({})))

    assert (artifact.content, artifact.truncated) == (b"Cut off mid-sen", True)
    assert handed.told.said() == [GENERATING, CREATING, complete(True)]


def test_a_job_that_states_plain_text_writes_plain_text(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = answering(monkeypatch, whole("c"))

    artifact = made(generate(Handed(1), job({"outputMediaType": "text/plain"})))

    assert ([call.output_media_type for call in asked], artifact.format) == (["text/plain"], "text/plain")


@pytest.mark.parametrize("media_type", ["image/png", "text/html"])
def test_a_format_the_registry_does_not_mark_generatable_is_refused_as_deterministic_before_anything_is_asked(
    monkeypatch: pytest.MonkeyPatch, media_type: str
) -> None:
    # Y1.
    asked = answering(monkeypatch, whole("c"))
    handed = Handed(1)

    with pytest.raises(DeterministicJobError) as refused:
        generate(handed, job({"outputMediaType": media_type}))

    assert classify_failure(refused.value) == "deterministic"
    assert str(refused.value) == (
        f"Unsupported outputMediaType for generation: {media_type}. Generation produces text/markdown or text/plain or application/pdf."
    )
    assert (asked, handed.told.reports) == ([], [])


# ── Y4: citations ───────────────────────────────────────────────────────


def test_with_cite_the_marks_are_taken_out_of_the_document_and_each_whose_id_the_context_showed_cites_the_claim_before_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answering(monkeypatch, whole("Paris is the capital of France. [[ctx-9]] It is large."))

    artifact = made(generate(Handed(1), job({"cite": True})))

    text = artifact.content.decode("utf-8")
    assert text == "Paris is the capital of France. It is large."
    assert artifact.citations == [
        GenerationCitation(resource_id=ResourceId("ctx-9"), annotation_id=None, start=0, end=31, exact="Paris is the capital of France.")
    ]
    # Offsets in the document as it is uploaded (Y7).
    assert text[0:31] == "Paris is the capital of France."


def test_a_mark_whose_id_the_context_did_not_show_is_taken_out_makes_no_citation_and_is_warned_of_once(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    answering(monkeypatch, whole("A bold claim. [[not-in-context]]"))

    artifact = made(generate(Handed(1), job({"cite": True})))

    assert (artifact.content, artifact.citations) == (b"A bold claim.", [])
    warned = [record for record in caplog.records if record.name == "semiont_worker" and record.levelno == logging.WARNING]
    assert [vars(record)["resourceId"] for record in warned] == ["not-in-context"]


@pytest.mark.parametrize("stated", [{}, {"cite": False}])
def test_without_cite_what_is_in_double_brackets_is_the_document_s_own(
    monkeypatch: pytest.MonkeyPatch, stated: dict[str, JsonValue]
) -> None:
    answering(monkeypatch, whole("Wiki-style [[ctx-9]] links are legitimate content."))

    artifact = made(generate(Handed(1), job(stated)))

    assert (artifact.content, artifact.citations) == (b"Wiki-style [[ctx-9]] links are legitimate content.", [])


# ── a PDF, of Typst the model writes ────────────────────────────────────

PDF: Final = Compiled(pdf=b"%PDF-STAND-IN\x00\xff")
UNCLOSED: Final = NotCompiled(error="error: unclosed delimiter\n  ┌─ doc.typ:1:14")
AS_PDF: Final[dict[str, JsonValue]] = {"title": "T", "outputMediaType": "application/pdf"}


def test_a_pdf_is_what_the_compiler_makes_of_the_typst_the_model_wrote(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = answering(monkeypatch, whole("= Title\nBody."))
    compiled = compiler_stood_in(monkeypatch, [PDF])
    handed = Handed(1)

    artifact = made(generate(handed, job(AS_PDF)))

    assert [(call.output_media_type, call.repair) for call in asked] == [("application/pdf", None)]
    assert compiled == ["= Title\nBody."]
    assert artifact == GeneratedArtifact(content=PDF.pdf, title="T", format="application/pdf", citations=[], truncated=False)
    assert handed.told.said() == [GENERATING, CREATING, complete(False)]


def test_a_source_cut_off_where_it_still_compiles_is_a_pdf_said_to_be_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    answering(monkeypatch, cut_off("= Title\nCut off"))
    compiler_stood_in(monkeypatch, [PDF])
    handed = Handed(1)

    artifact = made(generate(handed, job(AS_PDF)))

    assert (artifact.content, artifact.truncated) == (PDF.pdf, True)
    assert handed.told.said() == [GENERATING, CREATING, complete(True)]


@pytest.mark.parametrize(("stated", "ceiling"), [({}, "500"), ({"maxTokens": 1200}, "1200")])
def test_a_source_cut_off_where_it_does_not_compile_fails_at_once_naming_the_length_asked_for(
    monkeypatch: pytest.MonkeyPatch, stated: dict[str, JsonValue], ceiling: str
) -> None:
    # No repair restores what was never written: the source is cut off, and every repair is asked for at the same length.
    asked = answering(monkeypatch, cut_off("#let broken = [cut"))
    compiled = compiler_stood_in(monkeypatch, [UNCLOSED])
    handed = Handed(1)

    with pytest.raises(RuntimeError) as failed:
        generate(handed, job({**AS_PDF, **stated}))

    assert str(failed.value) == (
        f"Generation stopped at the maxTokens ceiling ({ceiling} tokens) and the cut-off Typst source does not compile "
        f"— repair cannot help; raise maxTokens. Compile error: {UNCLOSED.error}"
    )
    assert classify_failure(failed.value) is None
    assert (len(asked), compiled) == (1, ["#let broken = [cut"])
    assert handed.told.said() == [GENERATING]


def test_a_source_that_does_not_compile_is_handed_back_to_the_model_with_what_the_compiler_said(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    asked = answering(monkeypatch, whole("#let broken = [unclosed"), whole("= Fixed\nBody."))
    compiled = compiler_stood_in(monkeypatch, [UNCLOSED, PDF])
    handed = Handed(1)
    params = job(AS_PDF)

    artifact = made(generate(handed, params))

    assert artifact.content == PDF.pdf
    assert compiled == ["#let broken = [unclosed", "= Fixed\nBody."]
    # The second asking is of the same job, with the source that failed and the compiler's words.
    assert asked == [
        AskedToGenerate(params, "application/pdf", handed.client, None),
        AskedToGenerate(params, "application/pdf", handed.client, Repair(source="#let broken = [unclosed", error=UNCLOSED.error)),
    ]
    (warned,) = [record for record in caplog.records if record.getMessage() == "Typst compile failed — feeding the error back for repair"]
    assert (warned.levelno, vars(warned)["attempt"], vars(warned)["error"]) == (logging.WARNING, 1, UNCLOSED.error)
    assert handed.told.said() == [GENERATING, CREATING, complete(False)]


def test_what_the_compiler_said_is_logged_cut_at_five_hundred_code_points(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="semiont_worker")
    # A character outside the Basic Multilingual Plane is one code point of the five hundred.
    long = "\U0001f600" + "e" * 600
    asked = answering(monkeypatch, whole("#broken"), whole("= Fixed"))
    compiler_stood_in(monkeypatch, [NotCompiled(error=long), PDF])

    made(generate(Handed(1), job(AS_PDF)))

    (warned,) = [record for record in caplog.records if record.getMessage() == "Typst compile failed — feeding the error back for repair"]
    assert vars(warned)["error"] == "\U0001f600" + "e" * 499
    # The model is handed all of it.
    assert asked[1].repair == Repair(source="#broken", error=long)


def test_a_source_that_never_compiles_fails_the_job_after_the_bounded_repairs_with_what_the_compiler_said(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked = answering(monkeypatch, whole("#broken"))
    compiled = compiler_stood_in(monkeypatch, [UNCLOSED])
    handed = Handed(1)

    with pytest.raises(RuntimeError) as failed:
        generate(handed, job(AS_PDF))

    assert str(failed.value) == f"Typst compilation failed after {MAX_COMPILE_REPAIRS} repair attempts: {UNCLOSED.error}"
    assert classify_failure(failed.value) is None
    # The first asking, and one for each repair: a bounded number, and no more.
    assert len(asked) == len(compiled) == 1 + MAX_COMPILE_REPAIRS
    assert [call.repair for call in asked] == [None, *[Repair(source="#broken", error=UNCLOSED.error)] * MAX_COMPILE_REPAIRS]
    assert handed.told.said() == [GENERATING]


def test_with_cite_the_marks_are_taken_out_of_a_pdf_s_source_before_every_compile_and_a_repair_is_handed_the_source_without_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Y4: a mark never reaches what is rendered.
    asked = answering(
        monkeypatch,
        whole("= Answer\n#let x = [ Paris is the capital. [[ctx-9]]"),
        whole("= Answer\nParis is the capital of France. [[ctx-9]]"),
    )
    compiled = compiler_stood_in(monkeypatch, [UNCLOSED, PDF])

    artifact = made(generate(Handed(1), job({**AS_PDF, "cite": True})))

    assert compiled == ["= Answer\n#let x = [ Paris is the capital.", "= Answer\nParis is the capital of France."]
    assert asked[1].repair == Repair(source="= Answer\n#let x = [ Paris is the capital.", error=UNCLOSED.error)
    assert artifact.content == PDF.pdf
    # The citations are the repaired document's: the claim as its source has it, to be found again in what is rendered.
    assert [(citation.resource_id, citation.exact) for citation in artifact.citations] == [("ctx-9", "Paris is the capital of France.")]


def test_without_cite_a_pdf_s_source_is_compiled_as_the_model_wrote_it(monkeypatch: pytest.MonkeyPatch) -> None:
    answering(monkeypatch, whole("= Answer\nSee [[ctx-9]]."))
    compiled = compiler_stood_in(monkeypatch, [PDF])

    artifact = made(generate(Handed(1), job(AS_PDF)))

    assert (compiled, artifact.citations) == (["= Answer\nSee [[ctx-9]]."], [])


# ── what a generation may weigh ─────────────────────────────────────────


def test_an_artifact_at_the_most_a_resource_may_weigh_is_taken_and_one_byte_more_is_refused() -> None:
    assert_within_output_budget(0)
    assert_within_output_budget(MAX_OUTPUT_BYTES)
    with pytest.raises(RuntimeError) as refused:
        assert_within_output_budget(MAX_OUTPUT_BYTES + 1)
    assert str(refused.value) == (
        f"Generated artifact exceeds the output byte budget: {MAX_OUTPUT_BYTES + 1} bytes > {MAX_OUTPUT_BYTES}. "
        "Refusing a runaway generation."
    )
    assert classify_failure(refused.value) is None


def test_the_most_a_generated_artifact_may_weigh_is_the_most_the_smelter_reads() -> None:
    # A larger artifact would be a resource the Smelter declines as too large. The most a Smelter reads is the number the
    # table of what a PDF becomes states, which every Smelter is held to.
    table = LargestPdf.model_validate_json((SPEC / "smelter/extraction-cases.json").read_bytes())
    assert table.largest_pdf_bytes == MAX_OUTPUT_BYTES


def test_an_artifact_over_the_budget_is_refused_before_anything_says_it_is_being_created(monkeypatch: pytest.MonkeyPatch) -> None:
    answering(monkeypatch, whole("= Title"))
    compiler_stood_in(monkeypatch, [Compiled(pdf=b"x" * 9)])
    monkeypatch.setattr("semiont_worker.processors.MAX_OUTPUT_BYTES", 8)
    handed = Handed(1)

    with pytest.raises(RuntimeError, match="output byte budget: 9 bytes > 8"):
        generate(handed, job(AS_PDF))

    assert handed.told.said() == [GENERATING]


def test_a_text_over_the_budget_is_refused_by_its_weight_in_bytes_once_it_is_made(monkeypatch: pytest.MonkeyPatch) -> None:
    # Eight characters, which the budget would take, and nine bytes of UTF-8, which it does not.
    answering(monkeypatch, whole("Caf\N{LATIN SMALL LETTER E WITH ACUTE} bar"))
    monkeypatch.setattr("semiont_worker.processors.MAX_OUTPUT_BYTES", 8)
    handed = Handed(1)

    with pytest.raises(RuntimeError, match="output byte budget: 9 bytes > 8"):
        generate(handed, job({}))

    # A text is weighed as it is made into bytes, which is after the job says it is making the resource.
    assert handed.told.said() == [GENERATING, CREATING]
