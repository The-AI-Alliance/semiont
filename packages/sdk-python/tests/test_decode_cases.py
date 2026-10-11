"""What text a resource's bytes are, held to the two tables every reader of a resource's text runs.

`specs/src/text/decode-cases.json` is written by hand: what is said of a
content type, of a label, of a byte-order mark and of malformed UTF-8 and
UTF-16. `specs/src/text/encoding-cases.json` is generated: every label of the
Encoding Standard, and every byte of each of its single-byte encodings.

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
EVERY_BYTE: Final = bytes(range(256))


class Read(BaseModel, frozen=True, extra="forbid", strict=True):
    """A case whose bytes are a text."""

    why: str
    content_type: Annotated[str, Field(alias="contentType")]
    hexadecimal: Annotated[str, Field(alias="bytes")]
    text: str


class Refused(BaseModel, frozen=True, extra="forbid", strict=True):
    """A case whose charset is refused, by the label the refusal names."""

    why: str
    content_type: Annotated[str, Field(alias="contentType")]
    hexadecimal: Annotated[str, Field(alias="bytes")]
    refused: str


class Table(BaseModel, frozen=True):
    cases: list[Read | Refused]


class SingleByte(BaseModel, frozen=True, extra="forbid", strict=True):
    """A single-byte encoding: the text the 256 bytes, in order, are."""

    encoding: str
    labels: list[str]
    every_byte: Annotated[str, Field(alias="everyByte")]


class Probed(BaseModel, frozen=True, extra="forbid", strict=True):
    """An encoding told from the others by what some bytes are in it."""

    encoding: str
    labels: list[str]
    hexadecimal: Annotated[str, Field(alias="bytes")]
    text: str


class RefusedLabels(BaseModel, frozen=True, extra="forbid", strict=True):
    """An encoding every label of which is refused."""

    encoding: str
    labels: list[str]
    refused: Literal[True]


class Encodings(BaseModel, frozen=True):
    cases: list[SingleByte | Probed | RefusedLabels]


TABLE: Final = Table.model_validate_json((SPEC / "text/decode-cases.json").read_bytes())
ENCODINGS: Final = Encodings.model_validate_json((SPEC / "text/encoding-cases.json").read_bytes())
LABELS: Final = [(stated, label) for stated in ENCODINGS.cases for label in stated.labels]


def read(content_type: str, data: bytes) -> str:
    """What a client reads of some bytes, served with a content type."""

    async def scenario() -> str:
        made = create_test_client()
        made.content.seed(RESOURCE, Content(data=data, content_type=content_type))
        try:
            return await made.client.browse.resource_content(RESOURCE)
        finally:
            await made.client.close()

    return run(scenario())


def refused(content_type: str, data: bytes, label: str) -> None:
    """The reading is refused as a transport's failure, and the refusal names the label."""
    with pytest.raises(TransportError) as refusal:
        read(content_type, data)
    assert refusal.value.code == "error"
    assert label in str(refusal.value)


def test_the_runner_found_the_tables_cases() -> None:
    assert len(TABLE.cases) >= 90
    assert any(isinstance(case, Read) for case in TABLE.cases)
    assert any(isinstance(case, Refused) for case in TABLE.cases)
    assert sum(isinstance(case, SingleByte) for case in ENCODINGS.cases) >= 29
    assert any(isinstance(case, Probed) for case in ENCODINGS.cases)
    assert any(isinstance(case, RefusedLabels) for case in ENCODINGS.cases)
    assert len(LABELS) >= 180


@pytest.mark.parametrize("stated", TABLE.cases, ids=lambda stated: stated.why)
def test_a_resource_s_bytes_are_the_text_the_table_says(stated: Read | Refused) -> None:
    data = bytes.fromhex(stated.hexadecimal)
    match stated:
        case Read():
            assert read(stated.content_type, data) == stated.text
        case Refused():
            refused(stated.content_type, data, stated.refused)


@pytest.mark.parametrize(("stated", "label"), LABELS, ids=[f"{stated.encoding}: {label}" for stated, label in LABELS])
def test_every_label_of_the_standard_names_its_encoding_and_every_byte_is_its_character(
    stated: SingleByte | Probed | RefusedLabels, label: str
) -> None:
    content_type = f"text/plain; charset={label}"
    match stated:
        case SingleByte():
            assert read(content_type, EVERY_BYTE) == stated.every_byte
        case Probed():
            assert read(content_type, bytes.fromhex(stated.hexadecimal)) == stated.text
        case RefusedLabels():
            refused(content_type, EVERY_BYTE, label)
