"""What text a resource's bytes are, held to `specs/src/text/decode-cases.json`: the table every reader of a resource's text runs.

A worker reads a resource's text with `browse.resource_content` and counts its
offsets in what that gives. So each case is read through a client, from bytes
its content transport serves with the case's content type.
"""

from typing import Annotated, Final, Literal

import pytest
from aio import run
from pydantic import BaseModel, Field
from spec import SPEC

from semiont.errors import TransportError
from semiont.identifiers import ResourceId
from semiont.testing import create_test_client
from semiont.transport import Content

RESOURCE: Final = ResourceId("res-1")


class Read(BaseModel, frozen=True, extra="forbid", strict=True):
    """A case whose bytes are a text."""

    why: str
    content_type: Annotated[str, Field(alias="contentType")]
    hexadecimal: Annotated[str, Field(alias="bytes")]
    text: str


class Refused(BaseModel, frozen=True, extra="forbid", strict=True):
    """A case whose charset no reader decodes."""

    why: str
    content_type: Annotated[str, Field(alias="contentType")]
    hexadecimal: Annotated[str, Field(alias="bytes")]
    refused: Literal[True]


class Table(BaseModel, frozen=True):
    cases: list[Read | Refused]


TABLE: Final = Table.model_validate_json((SPEC / "text/decode-cases.json").read_bytes())


def read(case: Read | Refused) -> str:
    """What a client reads of a case's bytes, served with its content type."""

    async def scenario() -> str:
        made = create_test_client()
        made.content.seed(RESOURCE, Content(data=bytes.fromhex(case.hexadecimal), content_type=case.content_type))
        try:
            return await made.client.browse.resource_content(RESOURCE)
        finally:
            await made.client.close()

    return run(scenario())


def test_the_runner_found_the_table_s_cases() -> None:
    assert len(TABLE.cases) >= 19
    assert {type(case) for case in TABLE.cases} == {Read, Refused}


@pytest.mark.parametrize("stated", TABLE.cases, ids=lambda stated: stated.why)
def test_a_resource_s_bytes_are_the_text_the_table_says(stated: Read | Refused) -> None:
    match stated:
        case Read():
            assert read(stated) == stated.text
        case Refused():
            with pytest.raises(TransportError) as refused:
                read(stated)
            assert refused.value.code == "error"
