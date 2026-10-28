"""The origin of a knowledge base's gateway, from its HTTP endpoint.

One table, specs/src/session/gateway-url-cases.json, run by every SDK.
"""

from typing import Final

import pytest
from pydantic import BaseModel
from spec import SPEC

from semiont.http import gateway_url
from semiont.types import HttpEndpoint


class Case(BaseModel, frozen=True, extra="forbid"):
    why: str
    endpoint: HttpEndpoint
    origin: str | None


class Table(BaseModel, frozen=True):
    cases: list[Case]


TABLE: Final = Table.model_validate_json((SPEC / "session/gateway-url-cases.json").read_bytes())


@pytest.mark.parametrize("case", TABLE.cases, ids=lambda case: case.why)
def test_a_gateways_origin_is_as_the_shared_table_states(case: Case) -> None:
    if case.origin is None:
        with pytest.raises(ValueError, match="Invalid KB hostname"):
            gateway_url(case.endpoint)
    else:
        assert gateway_url(case.endpoint) == case.origin


def test_the_table_was_read() -> None:
    assert TABLE.cases
