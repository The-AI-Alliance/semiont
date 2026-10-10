"""What a generation says to its model.

Four prompts are stated outside any worker's source: the files
`yield-*.txt` of `tests/conformance/worker-service/prompts`, each the exact
text of one prompt less its one final line end. A prompt built here from what
the suite's case asked with, around the resource's text as the file carries
it, is that file's text.

What those four do not reach is stated by nothing but the TypeScript worker's
source: an annotation's comment, what a resource focus says beyond its
content, the knowledge graph and the similar passages, the tasks and the
structures but `prose`, Typst and a repair. Those are held here by whole
prompts written out by hand from that source, and word for word to the source
itself by `test_generation_typescript.py`.
"""

import logging
from typing import Final

import pytest
from pydantic import JsonValue
from semiont.types import GenerationJobParams, SupportedMediaType
from spec import ROOT

from semiont_worker.generation.resource_generation import (
    RESOURCE_CONTENT_CAP,
    SEMANTIC_MATCH_CODE_POINTS,
    SEMANTIC_MATCH_LIMIT,
    Repair,
    generation_prompt,
)
from semiont_worker.log import LOG

PROMPTS: Final = ROOT / "tests/conformance/worker-service/prompts"

type Wire = dict[str, JsonValue]
"""Part of a job, as the wire carries it."""

# What the suite's cases ask with (`yield.test.ts` and `anthropic.test.ts` there).
SOURCE: Final = "res-ws-yield-source"
SOURCE_DESCRIPTOR: Final[Wire] = {
    "@context": "https://schema.org",
    "@id": SOURCE,
    "name": "Notes on the engine",
    "representations": [{"mediaType": "text/markdown", "storageUri": f"file://worker-service/{SOURCE}", "rel": "original"}],
}
ASKED: Final[Wire] = {
    "title": "The Analytical Engine",
    "storageUri": "file://generated/analytical-engine.md",
    "prompt": "Write three sentences.",
    "entityTypes": ["Person"],
    "language": "en",
    "sourceLanguage": "en",
    "structure": "prose",
    "cite": True,
}
# What stands just before and just after the resource's text in a prompt that carries it.
CONTENT: Final = ("\n\nResource content:\n---\n", "\n---\n\nThe source resource and embedded context are in English.")


def stated(name: str) -> str:
    """A prompt of the suite: its file's text, less its one final line end."""
    text = (PROMPTS / f"{name}.txt").read_text(encoding="utf-8")
    assert text.endswith("\n"), f"{name}.txt does not end with the one line end the suite takes off"
    return text[:-1]


def job(asked: Wire, focus: Wire, shared: Wire) -> GenerationJobParams:
    """A `yield` job's params, read as the SDK reads them off the wire. `shared` is what a context holds beside its focus."""
    return GenerationJobParams.model_validate(
        {**asked, "context": {"focus": focus, "graph": {"nodes": [], "edges": []}, "metadata": {}, **shared}}
    )


def descriptor(resource_id: str, name: str) -> Wire:
    return {"@context": "https://schema.org", "@id": resource_id, "name": name, "representations": []}


def about_a_resource(asked: Wire, focus: Wire) -> GenerationJobParams:
    """A job focused on the resource `res-main`, with whatever `focus` says of it beside."""
    return job(
        {"storageUri": "file://generated/out", **asked}, {"kind": "resource", "resource": descriptor("res-main", "Main Notes"), **focus}, {}
    )


@pytest.mark.parametrize(
    ("name", "length"),
    [
        ("yield-markdown", {"maxTokens": 300, "temperature": 0.2}),
        ("yield-21333", {"maxTokens": 21333}),
        ("yield-21334", {"maxTokens": 21334}),
    ],
)
def test_a_job_focused_on_a_resource_is_asked_as_the_suite_s_file_says(name: str, length: Wire) -> None:
    file = stated(name)
    before, after = CONTENT
    assert before in file, f"{name}.txt does not have {before!r}"
    assert after in file, f"{name}.txt does not have {after!r}"
    text = file[file.index(before) + len(before) : file.rindex(after)]
    params = job({**ASKED, **length}, {"kind": "resource", "resource": SOURCE_DESCRIPTOR, "content": {"main": text, "related": {}}}, {})

    assert generation_prompt(params, "text/markdown", None) == file


def test_a_job_focused_on_an_annotation_is_asked_as_the_suite_s_file_says() -> None:
    focus: Wire = {
        "kind": "annotation",
        "annotation": {
            "@context": "http://www.w3.org/ns/anno.jsonld",
            "type": "Annotation",
            "id": "ann-ws-focus",
            "motivation": "linking",
            "target": {
                "source": SOURCE,
                "selector": [
                    {"type": "TextPositionSelector", "start": 119, "end": 134},
                    {"type": "TextQuoteSelector", "exact": "Charles Babbage"},
                ],
            },
            "body": [{"type": "TextualBody", "value": "Person", "purpose": "tagging"}],
            "created": "2026-01-01T00:00:00.000Z",
        },
        "sourceResource": SOURCE_DESCRIPTOR,
        "selected": {"before": "on the Analytical Engine.\n\n", "text": "Charles Babbage", "after": " designed the engine in London"},
        "userHint": "the mathematician, not the banker",
    }
    params = job(
        {"title": "Charles Babbage", "storageUri": "file://generated/babbage.txt", "language": "de", "outputMediaType": "text/plain"},
        focus,
        {},
    )

    assert generation_prompt(params, "text/plain", None) == stated("yield-annotation")


# What no file of the suite states. Each prompt is written out whole, from the TypeScript worker's source.

LONG: Final = "\U0001f600" * (SEMANTIC_MATCH_CODE_POINTS + 10)


def commented(motivation: str, body: JsonValue) -> Wire:
    """A focus that is an annotation of `motivation` in `res-main`, with `body`, around the words `in 1843`."""
    annotation: Wire = {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": "ann-focus",
        "motivation": motivation,
        "target": {"source": "res-main"},
        "created": "2026-01-01T00:00:00.000Z",
    }
    if body is not None:
        annotation["body"] = body
    return {
        "kind": "annotation",
        "annotation": annotation,
        "sourceResource": descriptor("res-main", "Main Notes"),
        "selected": {"text": "in 1843"},
    }


def node_of(annotation_id: str, on: str, entity_types: list[JsonValue]) -> Wire:
    return {
        "id": annotation_id,
        "type": "annotation",
        "label": "linking",
        "entityTypes": entity_types,
        "annotation": {
            "@context": "http://www.w3.org/ns/anno.jsonld",
            "type": "Annotation",
            "id": annotation_id,
            "motivation": "linking",
            "target": {"source": on},
            "created": "2026-01-01T00:00:00.000Z",
        },
    }


NEIGHBOURHOOD: Final[Wire] = {
    "graph": {
        "nodes": [
            {"id": "res-main", "type": "resource", "label": "Main Notes"},
            {"id": "res-peer", "type": "resource", "label": "Peer", "entityTypes": ["Author", "Org"]},
            {"id": "res-bare", "type": "resource", "label": "Bare"},
            {"id": "res-citing", "type": "resource", "label": "Citing Paper"},
            node_of("ann-cite", "res-citing", []),
            node_of("ann-sib", "res-main", ["Date"]),
            node_of("ann-focus", "res-main", ["Focal"]),
        ],
        "edges": [
            {"source": "res-main", "target": "res-peer", "type": "related"},
            {"source": "res-main", "target": "res-bare", "type": "related"},
            {"source": "ann-cite", "target": "res-citing", "type": "annotation-of"},
            {"source": "ann-cite", "target": "res-main", "type": "cites"},
            {"source": "ann-sib", "target": "res-main", "type": "annotation-of"},
            {"source": "ann-focus", "target": "res-main", "type": "annotation-of"},
        ],
    },
    "inferredRelationshipSummary": "Main Notes is cited once.",
    "semanticContext": {
        "similar": [
            {"text": "The least similar.", "resourceId": "res-low", "resourceName": "Low", "score": 0.2},
            {"text": "A scanned passage.", "resourceId": "res-scan", "resourceName": "Scan", "score": 0.875, "machineRead": True},
            {"text": "From an annotation.", "resourceId": "res-ann", "resourceName": "Annotated", "score": 0.9, "annotationId": "ann-9"},
            {"text": LONG, "resourceId": "res-long", "resourceName": "Long", "score": 0.625},
        ]
    },
}


def test_an_annotation_s_comment_its_neighbourhood_and_the_similar_passages_are_put_before_the_model() -> None:
    asked: Wire = {
        "title": "When was it published?",
        "storageUri": "file://generated/answer.md",
        "prompt": "Be brief.",
        "entityTypes": ["Person", "Date"],
        "language": "fr",
        "sourceLanguage": "de",
        "maxTokens": 800,
        "task": "answer",
        "structure": "sections",
        "cite": True,
    }
    body: JsonValue = [{"type": "TextualBody", "value": "A doubtful date.", "purpose": "commenting"}]
    params = GenerationJobParams.model_validate(
        {**asked, "context": {"focus": commented("commenting", body), "metadata": {}, **NEIGHBOURHOOD}}
    )

    # The three best passages, best first, each cut at 240 code points; a score is said to two places, a half rounded up.
    assert SEMANTIC_MATCH_LIMIT == 3
    assert generation_prompt(params, "text/markdown", None) == (
        'Answer the following question directly and concisely, grounded in the provided context: "When was it published?"\n'
        "Instruction: Be brief.\n"
        "Focus on these entity types: Person, Date.\n"
        "\n"
        "Annotation context:\n"
        "- Annotation motivation: commenting\n"
        "- Source resource: Main Notes [res-main]\n"
        "- Comment: A doubtful date.\n"
        "\n"
        "Source document context:\n"
        "---\n"
        "\n"
        "**[in 1843]**\n"
        "\n"
        "---\n"
        "\n"
        "\n"
        "Knowledge graph context:\n"
        "- Connected resources: Peer (Author, Org) [res-peer], Bare [res-bare]\n"
        "- This resource is cited by 1 other resource: Citing Paper [res-citing]\n"
        "- Related entity types in this document: Date\n"
        "- Relationship summary: Main Notes is cited once.\n"
        "\n"
        "Related passages from the knowledge base:\n"
        "- [res-ann/ann-9] (0.90) From an annotation.\n"
        "- [res-scan] (0.88) [OCR] A scanned passage.\n"
        f"- [res-long] (0.63) {LONG[:SEMANTIC_MATCH_CODE_POINTS]}\n"
        "Passages marked [OCR] were read from scanned images by character recognition; "
        "treat their exact wording and numbers as uncertain, and say so if you rely on one.\n"
        "\n"
        "The source resource and embedded context are in German.\n"
        "\n"
        "IMPORTANT: Write the entire resource in French.\n"
        "\n"
        "Requirements:\n"
        "- Aim for approximately 800 tokens of content\n"
        "- Be factual and informative\n"
        "- Organize the content into titled sections (## Section) with well-structured paragraphs\n"
        "- Start with a clear heading (# Title)\n"
        "- Ground every claim in the provided context. Immediately after each claim, cite its source by emitting [[<id>]], "
        "where <id> is an id shown in square brackets in the context above (for a passage labeled [abc], emit [[abc]]). "
        "Cite only ids that appear in the context.\n"
        "- Use markdown formatting\n"
        "- Write the response as markdown"
    )


def test_a_resource_s_summary_its_references_and_the_content_gathered_with_it_are_put_before_the_model() -> None:
    main = "\U0001f600" * (RESOURCE_CONTENT_CAP + 1)
    related = "R" * (RESOURCE_CONTENT_CAP + 1)
    params = about_a_resource(
        {"title": "The machine", "task": "summary", "structure": "chat"},
        {
            "summary": "Notes on a machine.",
            "suggestedReferences": ["Babbage", "Lovelace"],
            "content": {"main": main, "related": {"res-rel-1": "First related.", "res-rel-2": related}},
        },
    )

    # A resource's content is cut at 4000 code points, the focus's and each related one's: a character is never cut in two.
    assert generation_prompt(params, "text/plain", None) == (
        'Write a concise summary of "The machine".\n'
        "\n"
        "\n"
        "\n"
        "Resource context:\n"
        "- Resource: Main Notes [res-main]\n"
        "- Summary: Notes on a machine.\n"
        "- Suggested references: Babbage, Lovelace\n"
        "\n"
        "Resource content:\n"
        "---\n"
        f"{main[:RESOURCE_CONTENT_CAP]}\n"
        "---\n"
        "\n"
        "Related resource content:\n"
        "---\n"
        "[res-rel-1]\n"
        "First related.\n"
        "\n"
        "[res-rel-2]\n"
        f"{related[:RESOURCE_CONTENT_CAP]}\n"
        "---\n"
        "\n"
        "Requirements:\n"
        "- Aim for approximately 500 tokens of content\n"
        "- Be factual and informative\n"
        "- Structure the content as a conversational chat transcript — "
        "a sequence of alternating, speaker-labeled turns (no section headings)\n"
        "- Write the response as plain text — no formatting markup (no #, *, backticks, headings, or links)\n"
        "- Begin with the title on its own first line"
    )


def test_a_pdf_is_asked_for_as_typst_and_a_source_that_did_not_compile_is_handed_back(caplog: pytest.LogCaptureFixture) -> None:
    params = about_a_resource(
        {"title": "Engines", "prompt": "Keep it light.", "task": "Write a limerick.", "structure": "three stanzas"}, {}
    )
    repair = Repair(source="= T\n#let x = [", error="error: unclosed delimiter\n")

    assert generation_prompt(params, "application/pdf", repair) == (
        "Write a limerick.\n"
        'Topic: "Engines"\n'
        "Instruction: Keep it light.\n"
        "\n"
        "Your previous attempt failed to compile. Fix the error and return the complete corrected document — full source, not a diff.\n"
        "Compile error:\n"
        "error: unclosed delimiter\n"
        "\n"
        "Previous source:\n"
        "= T\n"
        "#let x = [\n"
        "\n"
        "\n"
        "Resource context:\n"
        "- Resource: Main Notes [res-main]\n"
        "\n"
        "Requirements:\n"
        "- Aim for approximately 500 tokens of content\n"
        "- Be factual and informative\n"
        "- Organize the output as: three stanzas\n"
        "- Write the response as Typst markup (the Typst typesetting language — not markdown, not LaTeX)\n"
        "- Headings are written as = Heading (deeper levels == Subheading); everything else is plain prose paragraphs\n"
        "- Do not emit markdown syntax or code fences"
    )
    # A task and a structure that are none of the canonical ones are passed on as written, and each is warned of.
    assert [
        (record.levelno, record.name, record.getMessage(), vars(record).get("task"), vars(record).get("structure"))
        for record in caplog.records
    ] == [
        (logging.WARNING, LOG.name, "Unknown task — using it verbatim as the framing instruction", "Write a limerick.", None),
        (logging.WARNING, LOG.name, "Unknown structure — passing it through as freeform organization guidance", None, "three stanzas"),
    ]


@pytest.mark.parametrize(
    ("media_type", "sections"),
    [
        (
            "text/markdown",
            "- Organize the content into titled sections (## Section) with well-structured paragraphs\n"
            "- Start with a clear heading (# Title)\n"
            "- Use markdown formatting",
        ),
        ("text/plain", "- Organize the content into titled sections with well-structured paragraphs\n- Write the response as plain text"),
        (
            "application/pdf",
            "- Organize the content into titled sections (= Heading) with well-structured paragraphs\n- Write the response as Typst markup",
        ),
    ],
)
def test_sections_are_asked_for_in_the_format_s_own_headings_and_a_title_only_of_markdown(
    media_type: SupportedMediaType, sections: str
) -> None:
    params = about_a_resource({"title": "Engines", "structure": "sections"}, {})

    assert f"\n- Be factual and informative\n{sections}" in generation_prompt(params, media_type, None)


@pytest.mark.parametrize(
    "asked",
    [
        {},
        {"task": "resource"},
        {"structure": ""},
        {"cite": False},
        {"prompt": ""},
        {"entityTypes": []},
        {"language": "en"},
        {"sourceLanguage": ""},
    ],
)
def test_what_a_job_leaves_unsaid_or_says_as_nothing_adds_nothing_to_its_prompt(asked: Wire, caplog: pytest.LogCaptureFixture) -> None:
    said = generation_prompt(about_a_resource({"title": "Engines", **asked}, {}), "text/markdown", None)

    assert said == (
        'Generate a concise, informative resource about "Engines".\n'
        "\n"
        "\n"
        "\n"
        "Resource context:\n"
        "- Resource: Main Notes [res-main]\n"
        "\n"
        "Requirements:\n"
        "- Aim for approximately 500 tokens of content\n"
        "- Be factual and informative\n"
        "- Use markdown formatting\n"
        "- Write the response as markdown"
    )
    assert caplog.records == []


@pytest.mark.parametrize(
    ("motivation", "body", "line"),
    [
        ("assessing", {"type": "TextualBody", "value": "Unsupported."}, "- Assessment: Unsupported."),
        ("commenting", {"type": "TextualBody", "value": "One body, and no list."}, "- Comment: One body, and no list."),
        # Only the first body is read, and only where it is text that says something.
        ("commenting", [{"type": "SpecificResource", "source": "res-peer"}, {"type": "TextualBody", "value": "Second."}], None),
        ("commenting", [{"type": "TextualBody", "value": ""}], None),
        ("commenting", None, None),
        # What any other annotation's body says is not said.
        ("linking", [{"type": "TextualBody", "value": "Person", "purpose": "tagging"}], None),
    ],
)
def test_only_a_comment_s_or_an_assessment_s_own_words_are_said_of_an_annotation(
    motivation: str, body: JsonValue, line: str | None
) -> None:
    params = job({"title": "Engines", "storageUri": "file://generated/out"}, commented(motivation, body), {})

    said = generation_prompt(params, "text/markdown", None)

    stated_of_it = f"- Annotation motivation: {motivation}\n- Source resource: Main Notes [res-main]\n" + (
        "" if line is None else f"{line}\n"
    )
    assert f"\n\nAnnotation context:\n{stated_of_it}\nSource document context:" in said


def test_a_language_the_registry_lacks_is_said_by_its_tag() -> None:
    said = generation_prompt(
        about_a_resource({"title": "Engines", "language": "pt-BR", "sourceLanguage": "tlh"}, {}), "text/markdown", None
    )

    assert (
        "\n\nThe source resource and embedded context are in tlh.\n\nIMPORTANT: Write the entire resource in pt-BR.\n\nRequirements:"
        in said
    )


def similar_to(matches: list[JsonValue]) -> str:
    """The prompt of a job whose context found `matches` similar, from where it says so on."""
    params = job(
        {"title": "Engines", "storageUri": "file://generated/out"},
        {"kind": "resource", "resource": descriptor("res-main", "Main Notes")},
        {"semanticContext": {"similar": matches}},
    )
    said = generation_prompt(params, "text/markdown", None)
    return said[said.index("- Resource: Main Notes [res-main]") :]


def passage(resource_id: str, score: float) -> JsonValue:
    return {"text": f"Of {resource_id}.", "resourceId": resource_id, "resourceName": resource_id, "score": score}


def test_no_passage_found_similar_says_nothing_of_passages() -> None:
    assert similar_to([]) == (
        "- Resource: Main Notes [res-main]\n"
        "\n"
        "Requirements:\n"
        "- Aim for approximately 500 tokens of content\n"
        "- Be factual and informative\n"
        "- Use markdown formatting\n"
        "- Write the response as markdown"
    )


def test_passages_of_one_score_keep_the_order_the_context_gave_them() -> None:
    said = similar_to([passage("res-a", 0.5), passage("res-b", 0.75), passage("res-c", 0.5), passage("res-d", 0.5)])

    assert said.startswith(
        "- Resource: Main Notes [res-main]\n"
        "\n"
        "Related passages from the knowledge base:\n"
        "- [res-b] (0.75) Of res-b.\n"
        "- [res-a] (0.50) Of res-a.\n"
        "- [res-c] (0.50) Of res-c.\n"
        "\n"
        "Requirements:"
    )


@pytest.mark.parametrize(
    ("score", "said"),
    [(0.125, "0.13"), (0.375, "0.38"), (0.625, "0.63"), (0.994, "0.99"), (0.995, "0.99"), (0.996, "1.00"), (1, "1.00"), (0, "0.00")],
)
def test_a_score_is_said_to_two_places_and_an_exact_half_is_rounded_up(score: float, said: str) -> None:
    # 0.995 is no exact half: the nearest number a float holds is under it.
    assert similar_to([passage("res-a", score)]).startswith(
        f"- Resource: Main Notes [res-main]\n\nRelated passages from the knowledge base:\n- [res-a] ({said}) Of res-a.\n"
    )
