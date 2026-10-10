"""Which `mark` job a holder was handed.

The spec states what the Dispatcher adds to a job's params and leaves the
held shape open, so a holder learns which of the five `mark` jobs it was
handed by asking. The answer is the job's description as the spec's shape
for its motivation, and it is only given for params that holder can run.
"""

from typing import Final, get_args

import pytest
from pydantic import JsonValue, ValidationError
from semiont.types import (
    AssessingJobParams,
    CommentingJobParams,
    HighlightingJobParams,
    JobParams,
    LinkingJobParams,
    Motivation,
    TaggingJobParams,
    TagSchema,
)

from semiont_worker.held_params import HeldTagging, held_mark

SCHEMA: Final[dict[str, JsonValue]] = {"id": "irac", "name": "IRAC", "description": "Legal analysis", "domain": "legal", "tags": []}


def held(params: dict[str, JsonValue]) -> JobParams:
    """Params as a claim hands them over: the job's own, and the resource the Dispatcher adds."""
    return JobParams.model_validate({"resourceId": "res-1", **params})


def test_the_answer_is_the_description_of_the_motivation_the_params_state_less_what_the_dispatcher_added() -> None:
    assert held_mark(held({"motivation": "highlighting", "instructions": "Mark dates.", "density": 5, "sourceLanguage": "fr"})) == (
        HighlightingJobParams(motivation="highlighting", instructions="Mark dates.", density=5, source_language="fr")
    )
    assert held_mark(held({"motivation": "commenting", "tone": "scholarly", "language": "de"})) == (
        CommentingJobParams(motivation="commenting", tone="scholarly", language="de")
    )
    assert held_mark(held({"motivation": "assessing", "tone": "critical"})) == AssessingJobParams(motivation="assessing", tone="critical")
    assert held_mark(held({"motivation": "linking", "entityTypes": ["Person"], "includeDescriptiveReferences": True})) == (
        LinkingJobParams(motivation="linking", entity_types=["Person"], include_descriptive_references=True)
    )


def test_every_motivation_the_spec_gives_a_mark_job_is_answered() -> None:
    stated: dict[str, dict[str, JsonValue]] = {
        "highlighting": {},
        "commenting": {},
        "assessing": {},
        "linking": {"entityTypes": ["Person"]},
        "tagging": {"schemaId": "irac", "categories": ["Issue"], "schema": SCHEMA},
    }
    assert set(get_args(get_args(Motivation.__value__)[0])) == set(stated)
    for motivation, params in stated.items():
        answered = held_mark(held({"motivation": motivation, **params}))
        described = answered.params if isinstance(answered, HeldTagging) else answered
        assert described is not None
        assert described.motivation == motivation


def test_params_that_state_no_motivation_or_one_that_is_no_mark_job_s_are_no_mark_job() -> None:
    # A `yield` job's.
    assert held_mark(held({"title": "Ouranos", "storageUri": "file://generated/ouranos.md"})) is None
    assert held_mark(held({"motivation": "bookmarking"})) is None
    assert held_mark(held({"motivation": 7})) is None


def test_a_tagging_job_is_taken_only_with_the_schema_the_dispatcher_resolved() -> None:
    asked: dict[str, JsonValue] = {"motivation": "tagging", "schemaId": "irac", "categories": ["Issue"]}
    # A `schemaId` alone is the request, and names a schema this holder cannot read.
    assert held_mark(held(asked)) is None
    assert held_mark(held({**asked, "schema": SCHEMA})) == HeldTagging(
        params=TaggingJobParams(motivation="tagging", schema_id="irac", categories=["Issue"]), schema=TagSchema.model_validate(SCHEMA)
    )


@pytest.mark.parametrize(
    "params",
    [
        # A member the motivation's shape does not have.
        {"motivation": "highlighting", "tone": "scholarly"},
        # One it has, of another type.
        {"motivation": "highlighting", "density": "many"},
        # One it requires, left out.
        {"motivation": "linking"},
    ],
)
def test_params_that_state_a_motivation_and_are_not_its_shape_are_refused_and_not_taken_for_another_job(
    params: dict[str, JsonValue],
) -> None:
    with pytest.raises(ValidationError):
        held_mark(held(params))
