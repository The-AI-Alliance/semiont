"""The stream's reader, held to `protocol/specs/src/bus/frame-cases.json`: the table every SDK's stream reader runs."""

import json
from typing import Final, Literal

import pytest
from pydantic import BaseModel
from spec import SPEC, JsonObject

from semiont._required import Fault
from semiont.http.stream import carried
from semiont.model import written


class Delivered(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame allows, which the reader delivers as it states it."""

    why: str
    frame: JsonObject


class Refused(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame does not allow, which the reader refuses for its first fault."""

    why: str
    frame: JsonObject
    refused: Literal[True]
    member: str
    """The way to the member its first fault is at: the names of the members it is within, and its own, joined by dots."""
    reason: Literal["lacks", "malformed"]


class Table(BaseModel, frozen=True):
    cases: list[Delivered | Refused]


TABLE: Final = Table.model_validate_json((SPEC / "bus/frame-cases.json").read_bytes())
DELIVERED: Final = [case for case in TABLE.cases if isinstance(case, Delivered)]
REFUSED: Final = [case for case in TABLE.cases if isinstance(case, Refused)]


def test_the_table_has_a_frame_of_each_kind() -> None:
    assert DELIVERED
    assert any(case.reason == "lacks" for case in REFUSED)
    assert any(case.reason == "malformed" for case in REFUSED)


@pytest.mark.parametrize("case", DELIVERED, ids=lambda case: case.why)
def test_a_frame_busframe_allows_is_read_as_it_states_it(case: Delivered) -> None:
    read = carried(json.dumps(case.frame))
    assert not isinstance(read, Fault), read
    assert written(read) == case.frame


@pytest.mark.parametrize("case", REFUSED, ids=lambda case: case.why)
def test_a_frame_busframe_does_not_allow_is_refused_for_the_fault_the_table_states(case: Refused) -> None:
    assert carried(json.dumps(case.frame)) == Fault(member=case.member, reason=case.reason)
