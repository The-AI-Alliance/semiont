"""The stream's reader, held to `protocol/specs/src/bus/frame-cases.json`: the table every SDK's stream reader runs."""

import json
from typing import Final, Literal

import pytest
from pydantic import BaseModel
from spec import SPEC, JsonObject

from semiont._required import Fault
from semiont.http.stream import Refused, carried
from semiont.model import written

type Told = Literal["readers", "failure-report"]


class Delivered(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame allows, which the reader delivers as it states it."""

    why: str
    frame: JsonObject


class RefusedFrame(BaseModel, frozen=True, extra="forbid"):
    """A frame BusFrame does not allow, which the reader refuses for its first fault."""

    why: str
    frame: JsonObject
    refused: Literal[True]
    member: str
    """The way to the member its first fault is at: the names of the members it is within, and its own, joined by dots."""
    reason: Literal["lacks", "malformed"]
    told: Told


class RefusedLine(BaseModel, frozen=True, extra="forbid"):
    """A `data` line that is no JSON, which the reader refuses as malformed."""

    why: str
    data: str
    refused: Literal[True]
    member: str
    reason: Literal["lacks", "malformed"]
    told: Told


class Table(BaseModel, frozen=True):
    cases: list[Delivered | RefusedFrame | RefusedLine]


TABLE: Final = Table.model_validate_json((SPEC / "bus/frame-cases.json").read_bytes())
DELIVERED: Final = [case for case in TABLE.cases if isinstance(case, Delivered)]
REFUSED: Final = [case for case in TABLE.cases if not isinstance(case, Delivered)]


def told(refused: Refused) -> Told:
    """Who is told of `refused`: the readers of the channel it names, or, when it names none, the failure report."""
    return "failure-report" if refused.channel is None else "readers"


def test_the_table_has_a_frame_of_each_kind() -> None:
    assert DELIVERED
    assert any(case.reason == "lacks" for case in REFUSED)
    assert any(case.reason == "malformed" for case in REFUSED)
    assert {case.told for case in REFUSED} == {"readers", "failure-report"}


@pytest.mark.parametrize("case", DELIVERED, ids=lambda case: case.why)
def test_a_frame_busframe_allows_is_read_as_it_states_it(case: Delivered) -> None:
    read = carried(json.dumps(case.frame))
    assert not isinstance(read, Refused), read
    assert written(read) == case.frame


@pytest.mark.parametrize("case", REFUSED, ids=lambda case: case.why)
def test_a_frame_busframe_does_not_allow_is_refused_for_the_fault_the_table_states_and_told_to_whom_it_states(
    case: RefusedFrame | RefusedLine,
) -> None:
    read = carried(json.dumps(case.frame) if isinstance(case, RefusedFrame) else case.data)
    assert isinstance(read, Refused), read
    assert (read.fault, told(read)) == (Fault(member=case.member, reason=case.reason), case.told)
    if isinstance(case, RefusedFrame) and read.channel is not None:
        assert read.channel == case.frame["channel"]
