"""What the table of what each schema requires holds a value to, besides its kinds and its members: read as every SDK reads it."""

from pydantic import JsonValue

from semiont._required import Fault, fault_of
from semiont.types import BrowseProfilesRequest, BusPingMessage, GatherAnnotationOptions


def malformed(member: str) -> Fault:
    return Fault(member=member, reason="malformed")


def test_a_value_is_one_of_its_values_of_its_form_and_of_its_size() -> None:
    cases: list[tuple[object, JsonValue, Fault | None]] = [
        (BusPingMessage, {"event": "ping", "data": ""}, None),
        (BusPingMessage, {"event": "pong", "data": ""}, malformed("event")),
        (BusPingMessage, {"event": "ping", "data": "x"}, malformed("data")),
        (BrowseProfilesRequest, {"dids": ["did:web:example.org"]}, None),
        (BrowseProfilesRequest, {"dids": ["did:\U0001f600"]}, None),
        (BrowseProfilesRequest, {"dids": []}, malformed("dids")),
        (BrowseProfilesRequest, {"dids": ["web:example.org"]}, malformed("dids")),
        (BrowseProfilesRequest, {"dids": ["did:web:a b"]}, malformed("dids")),
        (GatherAnnotationOptions, {"contextWindow": 100.0}, None),
        (GatherAnnotationOptions, {"contextWindow": 5000}, None),
        (GatherAnnotationOptions, {"contextWindow": 99}, malformed("contextWindow")),
        (GatherAnnotationOptions, {"contextWindow": 5001}, malformed("contextWindow")),
    ]
    for declared, value, fault in cases:
        assert fault_of(declared, value) == fault, value


def test_a_closed_object_carries_no_member_it_does_not_name() -> None:
    assert fault_of(BrowseProfilesRequest, {"dids": ["did:web:example.org"], "more": 1}) == malformed("more")
    assert fault_of(BrowseProfilesRequest, {"dids": [], "more": 1}) == malformed("dids")
    assert fault_of(BrowseProfilesRequest, {"more": 1}) == Fault(member="dids", reason="lacks")
    assert fault_of(BrowseProfilesRequest, {"dids": ["did:web:example.org"], "\U0001f600": 1, "｡": 1}) == malformed("｡")
