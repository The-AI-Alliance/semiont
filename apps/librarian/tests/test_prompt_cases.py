"""The five prompts, held to `specs/src/librarian/prompt-cases.json`.

It is the table every Librarian runs: what each prompt is made from, and its
text to the last character, its token limit and its temperature. Each prompt
here is a function of what the table says it is made from, so a case is one
call.
"""

from typing import Final

import pytest
from pydantic import JsonValue
from spec import SPEC, JsonObject, number, objects, read, strings, text, thing, whole

from semiont_librarian.prompts import (
    Candidate,
    Prompt,
    annotation_summary_prompt,
    reference_suggestions_prompt,
    relationship_prompt,
    resource_summary_prompt,
    score_prompt,
)
from semiont_librarian.replies import SCORE_ELEMENT, SUGGESTION_ELEMENT

TABLE: Final = read(SPEC / "librarian/prompt-cases.json")
CASES: Final = objects(TABLE["cases"], "the table's cases")

# What the table may say each prompt is made from. A case that states anything else states what this runner does not read.
MADE_FROM: Final = {
    "score": {"selected", "hint", "motivation", "source", "body", "entityTypes", "connected", "relationship", "candidates"},
    "relationship": {"passage", "connected", "citedBy", "siblingEntityTypes", "entityTypes"},
    "resource-summary": {"name", "content", "entityTypes"},
    "reference-suggestions": {"title", "entityType", "stub"},
    "annotation-summary": {"resource", "before", "selected", "after", "entityTypes"},
}


def whole_text(value: JsonValue, what: str) -> str:
    """A text the table states: a string, or the pieces of a long one, each a string or a string written a number of times."""
    if isinstance(value, str):
        return value
    assert isinstance(value, list), f"{what} is neither a text nor the pieces of one"
    pieces: list[str] = []
    for piece in value:
        if isinstance(piece, str):
            pieces.append(piece)
        else:
            repeated = thing(piece, f"a piece of {what}")
            assert set(repeated) == {"repeat", "times"}, f"a piece of {what} is not a text written a number of times"
            pieces.append(text(repeated["repeat"], "repeat") * whole(repeated["times"], "times"))
    return "".join(pieces)


def stated_text(of: JsonObject, name: str) -> str | None:
    """A text a case may leave out."""
    return whole_text(of[name], name) if name in of else None


def made(prompt: str, of: JsonObject) -> Prompt:
    """The prompt made from what a case states."""
    assert set(of) <= MADE_FROM[prompt], f"the case states something a {prompt} prompt is not made from"
    match prompt:
        case "score":
            return score_prompt(
                selected=stated_text(of, "selected"),
                hint=stated_text(of, "hint"),
                motivation=text(of["motivation"], "motivation"),
                source=text(of["source"], "source"),
                body=stated_text(of, "body"),
                entity_types=strings(of["entityTypes"], "entityTypes"),
                connected=strings(of["connected"], "connected"),
                relationship=stated_text(of, "relationship"),
                candidates=[
                    Candidate(
                        id=text(candidate["id"], "a candidate's id"),
                        name=text(candidate["name"], "a candidate's name"),
                        entity_types=tuple(strings(candidate["entityTypes"], "a candidate's entityTypes")),
                    )
                    for candidate in objects(of["candidates"], "candidates")
                ],
            )
        case "relationship":
            return relationship_prompt(
                passage=text(of["passage"], "passage"),
                connected=strings(of["connected"], "connected"),
                cited_by=strings(of["citedBy"], "citedBy"),
                sibling_entity_types=strings(of["siblingEntityTypes"], "siblingEntityTypes"),
                entity_types=strings(of["entityTypes"], "entityTypes"),
            )
        case "resource-summary":
            return resource_summary_prompt(
                name=text(of["name"], "name"),
                content=whole_text(of["content"], "content"),
                entity_types=strings(of["entityTypes"], "entityTypes"),
            )
        case "reference-suggestions":
            return reference_suggestions_prompt(
                title=text(of["title"], "title"),
                entity_type=stated_text(of, "entityType"),
                stub=stated_text(of, "stub"),
            )
        case "annotation-summary":
            return annotation_summary_prompt(
                resource=text(of["resource"], "resource"),
                before=whole_text(of["before"], "before"),
                selected=whole_text(of["selected"], "selected"),
                after=whole_text(of["after"], "after"),
                entity_types=strings(of["entityTypes"], "entityTypes"),
            )
        case _:
            raise AssertionError(f"{prompt} is none of the Librarian's prompts")


def test_the_runner_found_the_table_s_cases_and_each_of_the_five_prompts() -> None:
    assert len(CASES) >= 40
    assert {text(case["prompt"], "prompt") for case in CASES} == set(MADE_FROM)


def named(case: JsonObject) -> str:
    """What a case is called: its prompt, and why it is a case."""
    return text(case["prompt"], "prompt") + ": " + text(case["why"], "why")


@pytest.mark.parametrize("case", CASES, ids=[named(case) for case in CASES])
def test_a_prompt_is_the_text_the_table_gives_with_its_token_limit_and_its_temperature(case: JsonObject) -> None:
    assert set(case) == {"why", "prompt", "from", "text", "maxTokens", "temperature"}
    expected = Prompt(
        text=whole_text(case["text"], "text"),
        max_tokens=whole(case["maxTokens"], "maxTokens"),
        temperature=number(case["temperature"], "temperature"),
    )
    assert made(text(case["prompt"], "prompt"), thing(case["from"], "from")) == expected, text(case["why"], "why")


# The table holds every cut where every count is the same. This holds what a cut counts.


def test_the_two_prompts_asked_for_elements_are_sent_with_the_schemas_the_table_states() -> None:
    assert set(TABLE) == {"$comment", "elements", "cases"}
    assert thing(TABLE["elements"], "elements") == {"score": SCORE_ELEMENT, "reference-suggestions": SUGGESTION_ELEMENT}


def test_a_cut_counts_code_points_and_splits_no_character() -> None:
    book = "\U0001f4d6"
    summary = resource_summary_prompt(name="Books", content=book * 2001, entity_types=[])
    assert f"\n{book * 2000}...\n" in summary.text
    suggestions = reference_suggestions_prompt(title="Books", stub=book * 501)
    assert f'"{book * 500}"' in suggestions.text
    passage = annotation_summary_prompt(resource="Books", before="a" + book * 200, selected="it", after=book * 200 + "z", entity_types=[])
    assert f'Context before: "{book * 200}"\n' in passage.text
    assert f'Context after: "{book * 200}"\n' in passage.text
