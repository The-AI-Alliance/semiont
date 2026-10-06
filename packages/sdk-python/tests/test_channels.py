"""The bus's vocabulary, as generated: every channel and every operation the registry states."""

import re
from typing import get_args

import pytest
from pydantic import ValidationError
from spec import SPEC, objects, read, text

from semiont import channels, operations
from semiont.channel import Empty
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import WireModel
from semiont.types import EnrichedResourceEvent, MarkDeleteCommand, StoredEventResponse

REGISTRY = read(SPEC / "bus/registry.json")
STATED = objects(REGISTRY["channels"], "channels")
BY_NAME = channels.CHANNELS


def constant(name: str) -> str:
    """`mark:assist-timeout` → `MARK_ASSIST_TIMEOUT`."""
    return re.sub(r"[^A-Za-z0-9]+", "_", name).upper()


def test_every_channel_of_the_registry_is_a_constant_under_its_own_name() -> None:
    names = [text(stated["channel"], "a channel's name") for stated in STATED]
    assert list(channels.CHANNEL_NAMES) == names
    assert list(get_args(channels.ChannelName.__value__)) == names
    assert list(BY_NAME) == names
    for name in names:
        assert BY_NAME[name].name == name
        assert getattr(channels, constant(name)) is BY_NAME[name]


def test_a_channel_s_payload_is_what_its_shape_says() -> None:
    for stated in STATED:
        payload = BY_NAME[text(stated["channel"], "a channel's name")].payload
        assert issubclass(payload, WireModel)
        match stated["shape"]:
            case "schema":
                assert payload.__name__ == stated["schema"]
            case "envelope":
                assert payload.__name__ == f"Response[{text(stated['schema'], 'a schema')}]"
            case "storedEvent":
                assert payload is (EnrichedResourceEvent if stated.get("enriched") is True else StoredEventResponse)
            case "void" | "empty":
                assert payload is Empty
            case other:
                raise AssertionError(f"a shape this test does not know: {other!r}")


def test_every_operation_of_the_registry_names_its_three_channels() -> None:
    stated = objects(REGISTRY["operations"], "operations")
    by_request = operations.OPERATIONS
    assert list(by_request) == [text(entry["request"], "a request") for entry in stated]
    for entry in stated:
        operation = by_request[text(entry["request"], "a request")]
        assert getattr(operations, constant(text(entry["request"], "a request"))) is operation
        assert operation.request is BY_NAME[text(entry["request"], "a request")]
        assert operation.result is BY_NAME[text(entry["result"], "a result")]
        assert operation.failure is BY_NAME[text(entry["failure"], "a failure")]


def test_a_channel_decodes_what_it_carries_and_writes_it_by_the_wire_s_names() -> None:
    command = channels.MARK_DELETE.decode({"annotationId": "a-1", "resourceId": "res-1"})
    assert command == MarkDeleteCommand(annotation_id=AnnotationId("a-1"), resource_id=ResourceId("res-1"))
    assert channels.MARK_DELETE.encode(command) == {"annotationId": "a-1", "resourceId": "res-1"}
    assert channels.MARK_DELETE.encode(MarkDeleteCommand(annotation_id=AnnotationId("a-1"))) == {"annotationId": "a-1"}
    assert type(BY_NAME["mark:delete"].decode({"annotationId": "a-1"})) is MarkDeleteCommand


def test_a_channel_refuses_what_is_not_its_payload() -> None:
    with pytest.raises(ValidationError):
        channels.MARK_DELETE.decode({"annotationId": "not an id"})
    with pytest.raises(ValidationError):
        channels.MARK_DELETE.decode({"resourceId": "res-1"})
    with pytest.raises(ValidationError):
        channels.MARK_CANCEL_PENDING.decode({"unexpected": True})
