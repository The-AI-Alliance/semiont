"""When a registry takes two endpoints for one place, and the order it shows what is open in.

Both tables of protocol/specs/src/session/registry-cases.json, run by every SDK.
"""

from typing import Final

import pytest
from pydantic import BaseModel, Field
from spec import SPEC

from semiont._endpoints import same_place
from semiont.identifiers import ResourceId
from semiont.registry import sort_open_resources
from semiont.stored import OpenResource
from semiont.types import KbEndpoint


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    one: KbEndpoint
    other: KbEndpoint
    same_place: bool = Field(alias="samePlace")


class OrderCase(BaseModel, frozen=True, extra="forbid"):
    why: str
    open: list[OpenResource]
    shown: list[ResourceId]


class Table(BaseModel, frozen=True):
    cases: list[Case]
    open_resource_order: list[OrderCase] = Field(alias="openResourceOrder")


TABLE: Final = Table.model_validate_json((SPEC / "session/registry-cases.json").read_bytes())


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_one_place_is_as_the_shared_table_states(case: Case) -> None:
    assert same_place(case.one, case.other) is case.same_place
    assert same_place(case.other, case.one) is case.same_place


@pytest.mark.parametrize("case", TABLE.open_resource_order, ids=lambda case: case.why)
def test_what_is_open_is_shown_in_the_order_the_shared_table_states(case: OrderCase) -> None:
    assert [resource.id for resource in sort_open_resources(case.open)] == case.shown


def test_the_table_was_read() -> None:
    assert TABLE.cases
    assert TABLE.open_resource_order
