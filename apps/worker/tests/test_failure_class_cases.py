"""`classify_failure`, held to `specs/src/worker/failure-class-cases.json`.

It is the table every worker's classification runs, so that a failure is
reported in one class whichever language the worker is written in.
"""

import asyncio
from typing import Annotated, Final, Literal

import pytest
from pydantic import BaseModel, Field
from semiont.errors import TransportError
from semiont.retry import RetryFacts
from semiont.types import FailureClass
from semiont_inference.interface import ProviderStatusError, ProviderWithheldError, StructuredReadError, StructuredUnsupportedError
from spec import SPEC

from semiont_worker.detection.chunk_plan import UnderReportedPiece, YieldCollapseError
from semiont_worker.failure_class import JOB, DeterministicJobError, classify_failure
from semiont_worker.inference_call import InferenceTimeoutError


class Described(BaseModel, frozen=True, extra="forbid", strict=True):
    """A failure as the table describes one: whichever of these it has."""

    name: str | None = None
    aborted: Literal[True] | None = None
    status: int | str | None = None
    stop_reason: Annotated[str | None, Field(alias="stopReason")] = None


class Case(BaseModel, frozen=True, extra="forbid", strict=True):
    why: str
    failure: Described | str | None
    failure_class: Annotated[FailureClass | None, Field(alias="failureClass")]


class Table(BaseModel, frozen=True, extra="forbid", strict=True):
    comment: Annotated[str, Field(alias="$comment")]
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "worker/failure-class-cases.json").read_bytes())

SAID: Final = "described by the table"


def named(described: Described) -> BaseException:
    """The worker's or the driver's own failure of the name the table gives, or a plain one where it gives none.

    A name this runner does not have is refused: the table names no library's failure.
    """
    if described.name != "StructuredReadError":
        assert described.stop_reason is None, f"the table gives a stop reason to {described.name}, which carries none"
    match described.name:
        case "DeterministicJobError":
            return DeterministicJobError(SAID)
        case "YieldCollapseError":
            return YieldCollapseError(SAID, [], UnderReportedPiece(found=0, counted=0, piece_chars=0))
        case "InferenceTimeoutError":
            return InferenceTimeoutError(SAID)
        case "StructuredUnsupportedError":
            return StructuredUnsupportedError(SAID)
        case "StructuredReadError":
            assert described.stop_reason is not None, "the table describes a StructuredReadError with no stop reason"
            return StructuredReadError(SAID, described.stop_reason)
        case "ProviderWithheldError":
            return ProviderWithheldError(SAID, "refusal")
        case "ProviderStatusError":
            assert isinstance(described.status, int), "the table describes a ProviderStatusError with no status"
            return ProviderStatusError(SAID, described.status)
        case None:
            return Exception(SAID)
        case _:
            pytest.fail(f"the table names {described.name}, which is no failure of the worker's or of its drivers'")


def failure_of(described: Described | str | None) -> object:
    """The failure a case describes: the language's abort where it says the call was aborted, and otherwise the one it names.

    The status given is put on whichever it is. What is text or nothing is
    handed over as it is: something that is no failure at all.
    """
    if described is None or isinstance(described, str):
        return described
    if described.aborted:
        assert described.name is None, "the table describes an abort that is also a named failure"
        failure: BaseException = asyncio.CancelledError(SAID)
    else:
        failure = named(described)
    if described.status is not None:
        vars(failure)["status"] = described.status
    return failure


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 25


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_failure_is_classed_as_the_table_says(case: Case) -> None:
    assert classify_failure(failure_of(case.failure)) == case.failure_class, case.why


# The table puts a status on a plain failure. These are the failures that carry one where the worker runs.


@pytest.mark.parametrize(
    ("status", "failure_class"), [(404, "deterministic"), (401, "deterministic"), (503, "transient"), (429, "transient")]
)
def test_a_request_the_gateway_refused_is_classed_by_the_status_the_sdk_s_failure_carries(status: int, failure_class: FailureClass) -> None:
    assert classify_failure(TransportError.of_status("refused", status, None)) == failure_class


def test_a_request_nothing_answered_carries_no_status_and_is_not_classed() -> None:
    assert classify_failure(TransportError.without_response("no answer")) is None


def test_every_status_is_classed_by_the_job_rule_and_by_no_second_list() -> None:
    for status in range(100, 600):
        expected = "transient" if JOB.retryable(RetryFacts(status=status)) else "deterministic" if status >= 400 else None
        assert classify_failure(ProviderStatusError("refused", status)) == expected, status
