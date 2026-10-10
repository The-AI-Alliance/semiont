"""The statuses a job's failure is retried for, held to the `job` rows of `specs/src/retry/cases.json`.

The table states four rules. The SDK keeps three of them and names `job` as
its worker's. This is that worker, and it keeps the one.
"""

from typing import Final

import pytest
from pydantic import BaseModel
from semiont.retry import RETRY_RULES, RetryFacts
from spec import SPEC

from semiont_worker.failure_class import JOB


class Row(BaseModel, frozen=True, extra="forbid", strict=True):
    why: str
    rule: str
    status: int | None = None
    method: str | None = None
    retries: bool


class Table(BaseModel, frozen=True):
    rules: list[Row]


TABLE: Final = Table.model_validate_json((SPEC / "retry/cases.json").read_bytes())
ROWS: Final = [row for row in TABLE.rules if row.rule == JOB.name]


def test_the_runner_found_the_rule_s_rows() -> None:
    assert len(ROWS) >= 7
    assert {row.retries for row in ROWS} == {True, False}


def test_every_rule_of_the_table_is_kept_by_the_sdk_or_is_this_one() -> None:
    # A rule the table gains, or one the SDK comes to keep too, fails here until this file says whose it is.
    assert {row.rule for row in TABLE.rules} == set(RETRY_RULES) | {JOB.name}
    assert JOB.name not in RETRY_RULES


@pytest.mark.parametrize("row", ROWS, ids=lambda row: row.why)
def test_the_job_rule_answers_as_the_table_does(row: Row) -> None:
    assert JOB.retryable(RetryFacts(status=row.status, method=row.method)) is row.retries, row.why


def test_a_failure_that_states_no_status_is_not_one_the_rule_retries() -> None:
    assert JOB.retryable(RetryFacts()) is False
