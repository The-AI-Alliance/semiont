"""What a Librarian reads of the record and of the profiles of the principals, each asked of the Archivist over the bus.

Each read is answered here as the Archivist answers it, through a transport
whose stream names the replies of `READ` and no other: an operation the
readers ask that is not among them is never answered. A resource the record
does not hold is `None`, and so is an annotation the Archivist refuses to
read; every other failure is raised.
"""

from collections.abc import Mapping, Sequence
from typing import Final

import pytest
from aio import hurried, run
from pydantic import JsonValue
from rig import ADA_ID, LOVELACE, RECORDED, described, reference
from semiont.bus import Bus, reply_channels_for
from semiont.errors import BusRequestError
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.testing import DropReply, FaultAction, FaultyTransport, Refuse

from semiont_librarian.reads import Described, ProfilesUnread
from semiont_librarian.record import READ, BusProfiles, BusRecord

R1: Final = ResourceId("res-1")
NOTE_ID: Final = AnnotationId("ann-1")
GRACE_ID: Final = "did:web:example.org:users:grace"

HELD: Final = described(R1, name="Black Hawk")
NOTE: Final = reference(NOTE_ID, R1)


def archivist(operation: str, payload: Mapping[str, JsonValue]) -> JsonValue:
    """What the Archivist answers each read with: the one resource it holds, the one annotation on it, and Ada's profile."""
    if operation == "browse:resource-requested":
        return {"resource": written(HELD), "lastSequence": 3}
    if operation == "browse:annotation-requested":
        return {"annotation": written(NOTE), "resource": written(HELD), "resolvedResource": None}
    if operation == "browse:profiles-requested":
        return {"profiles": {ADA_ID: {"name": "Ada Lovelace", "since": RECORDED}}}
    raise AssertionError(f"the Librarian asked {operation}, which it is not to")


def wire(refuse: Refuse | None = None, schedule: Sequence[FaultAction] = ()) -> FaultyTransport:
    """A transport whose stream names the replies of what a Librarian reads, answered as the Archivist answers them."""
    transport = FaultyTransport(schedule, make_response=archivist, channels=reply_channels_for(*READ))
    if refuse is not None:
        transport.refuse_when(refuse)
    return transport


def asked(transport: FaultyTransport) -> list[tuple[str, Mapping[str, JsonValue]]]:
    """Each request sent, by its channel, with what it asked."""
    return [(entry.channel, entry.payload) for entry in transport.request_log]


def test_a_resource_is_its_descriptor_and_the_sequence_number_of_its_last_event() -> None:
    async def scenario() -> None:
        transport = wire()
        assert await BusRecord(Bus(transport)).described(R1) == Described(resource=HELD, last_sequence=3)
        assert asked(transport) == [("browse:resource-requested", {"resourceId": R1})]
        await transport.close()

    run(scenario())


def test_a_resource_the_record_does_not_hold_is_none() -> None:
    def refuse(operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        return {"code": "not-found", "message": f"no resource {payload['resourceId']}"}

    async def scenario() -> None:
        transport = wire(refuse)
        assert await BusRecord(Bus(transport)).described(R1) is None
        await transport.close()

    run(scenario())


def test_a_resource_read_that_fails_otherwise_is_raised() -> None:
    def refuse(operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        return {"message": "the Archivist could not read its view"}

    async def scenario() -> None:
        refused = wire(refuse)
        with pytest.raises(BusRequestError) as failure:
            await BusRecord(Bus(refused)).described(R1)
        assert failure.value.code == "bus.rejected"
        await refused.close()

        unanswered = wire(schedule=[DropReply()])
        with pytest.raises(BusRequestError) as timed_out:
            await hurried(BusRecord(Bus(unanswered)).described(R1))
        assert timed_out.value.code == "bus.timeout"
        await unanswered.close()

    run(scenario())


def test_an_annotation_is_the_one_the_archivist_holds_on_the_resource() -> None:
    async def scenario() -> None:
        transport = wire()
        assert await BusRecord(Bus(transport)).annotation(R1, NOTE_ID) == NOTE
        assert asked(transport) == [("browse:annotation-requested", {"resourceId": R1, "annotationId": NOTE_ID})]
        await transport.close()

    run(scenario())


def test_an_annotation_the_archivist_refuses_is_none() -> None:
    # Asked of a resource the record holds, the Archivist's one refusal is that the annotation is not in it. It states no code.
    def refuse(operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        return {"message": f"no annotation {payload['annotationId']}"}

    async def scenario() -> None:
        transport = wire(refuse)
        assert await BusRecord(Bus(transport)).annotation(R1, NOTE_ID) is None
        await transport.close()

    run(scenario())


def test_an_annotation_read_the_archivist_does_not_answer_is_raised() -> None:
    def refuse(operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        return {"code": "peer-unavailable", "message": "nothing answers"}

    async def scenario() -> None:
        unanswered = wire(schedule=[DropReply()])
        with pytest.raises(BusRequestError) as timed_out:
            await hurried(BusRecord(Bus(unanswered)).annotation(R1, NOTE_ID))
        assert timed_out.value.code == "bus.timeout"
        await unanswered.close()

        absent = wire(refuse)
        with pytest.raises(BusRequestError) as unavailable:
            await BusRecord(Bus(absent)).annotation(R1, NOTE_ID)
        assert unavailable.value.code == "bus.peer-unavailable"
        await absent.close()

        closed = wire()
        await closed.close()
        with pytest.raises(BusRequestError) as shut:
            await BusRecord(Bus(closed)).annotation(R1, NOTE_ID)
        assert shut.value.code == "bus.closed"

    run(scenario())


def test_the_profiles_are_asked_by_the_dids_given_and_each_that_has_one_is_answered() -> None:
    async def scenario() -> None:
        transport = wire()
        assert await BusProfiles(Bus(transport)).of([ADA_ID, GRACE_ID]) == LOVELACE
        assert asked(transport) == [("browse:profiles-requested", {"dids": [ADA_ID, GRACE_ID]})]
        await transport.close()

    run(scenario())


def test_no_one_is_asked_after_for_no_dids_nor_for_a_text_that_is_no_did() -> None:
    async def scenario() -> None:
        transport = wire()
        profiles = BusProfiles(Bus(transport))
        assert await profiles.of([]) == {}
        assert await profiles.of(["constructor", "an id with spaces"]) == {}
        assert asked(transport) == []
        assert await profiles.of(["constructor", ADA_ID]) == LOVELACE
        assert asked(transport) == [("browse:profiles-requested", {"dids": [ADA_ID]})]
        await transport.close()

    run(scenario())


def test_more_principals_than_one_request_may_ask_after_are_asked_after_in_parts_each_once() -> None:
    async def scenario() -> None:
        transport = wire()
        many = [f"did:web:example.org:users:person-{n}" for n in range(501)]
        assert await BusProfiles(Bus(transport)).of([*many, ADA_ID, ADA_ID]) == LOVELACE
        assert asked(transport) == [
            ("browse:profiles-requested", {"dids": many[:500]}),
            ("browse:profiles-requested", {"dids": [many[500], ADA_ID]}),
        ]
        await transport.close()

    run(scenario())


def test_profiles_that_cannot_be_read_are_unread() -> None:
    def refuse(operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        return {"code": "peer-unavailable", "message": "nothing answers"}

    async def scenario() -> None:
        transport = wire(refuse)
        with pytest.raises(ProfilesUnread) as unread:
            await BusProfiles(Bus(transport)).of([ADA_ID])
        assert isinstance(unread.value.__cause__, BusRequestError)
        await transport.close()

    run(scenario())
