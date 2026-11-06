"""When a registry takes two endpoints for one place.

One table, protocol/specs/src/session/registry-cases.json, run by every SDK.
"""

from typing import Final

import pytest
from pydantic import BaseModel, Field
from spec import SPEC

from semiont._endpoints import same_place
from semiont.types import KbEndpoint


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    one: KbEndpoint
    other: KbEndpoint
    same_place: bool = Field(alias="samePlace")


class Table(BaseModel, frozen=True):
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "session/registry-cases.json").read_bytes())


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_one_place_is_as_the_shared_table_states(case: Case) -> None:
    assert same_place(case.one, case.other) is case.same_place
    assert same_place(case.other, case.one) is case.same_place


def test_the_table_was_read() -> None:
    assert TABLE.cases
