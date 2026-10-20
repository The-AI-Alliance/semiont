"""What a Librarian reads of the record, and what the knowledge base calls its people: each asked of the Archivist, over the bus.

The Archivist keeps both, and a Librarian only reads them
(`docs/protocol/LIBRARIAN.md` § What it answers, § Names). Each read is
bounded by its question: a resource's descriptor and the sequence number of
its last event (`browse:resource-requested`), one annotation on a resource
(`browse:annotation-requested`), and the profiles of the people a reply
names (`browse:people-requested`). It opens no file of the record. A
resource's bytes are another read, and no part of this
(`semiont_service.content`).
"""

from collections.abc import Mapping, Sequence
from typing import Final, final, override

from semiont.bus import Bus
from semiont.errors import BusRequestError, TransportError
from semiont.identifiers import AnnotationId, ResourceId, UserId
from semiont.operations import BROWSE_ANNOTATION_REQUESTED, BROWSE_PEOPLE_REQUESTED, BROWSE_RESOURCE_REQUESTED
from semiont.types import Annotation, BrowseAnnotationRequest, BrowsePeopleRequest, BrowseResourceRequest, PersonProfile

from semiont_librarian.reads import Described, People, PeopleUnread, Record

__all__ = ["READ", "BusPeople", "BusRecord"]

READ: Final = (BROWSE_RESOURCE_REQUESTED, BROWSE_ANNOTATION_REQUESTED, BROWSE_PEOPLE_REQUESTED)
"""The operations a Librarian awaits: its stream names their replies."""


def _asked_at_once() -> int:
    """How many people one request may ask after: the bound the request's own schema states (`BrowsePeopleRequest`)."""
    bound = BrowsePeopleRequest.model_json_schema()["properties"]["dids"]["maxItems"]
    if not isinstance(bound, int):
        raise TypeError("BrowsePeopleRequest states no bound on how many people one request asks after")
    return bound


_ASKED_AT_ONCE: Final = _asked_at_once()


@final
class BusRecord(Record):
    """The record, as a Librarian reads it over `bus`."""

    def __init__(self, bus: Bus) -> None:
        self._bus: Final = bus

    @override
    async def described(self, resource_id: ResourceId) -> Described | None:
        """A resource as the Archivist describes it now. `None` where it holds no such resource; any other failure is raised."""
        try:
            answered = (await self._bus.request(BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resource_id=resource_id))).response
        except BusRequestError as failure:
            if failure.code == "bus.not-found":
                return None
            raise
        return Described(resource=answered.resource, last_sequence=answered.last_sequence)

    @override
    async def annotation(self, resource_id: ResourceId, annotation_id: AnnotationId) -> Annotation | None:
        """An annotation on a resource, as the Archivist holds it now. `None` where it refuses the read.

        It is asked only of a resource the record holds, and the Archivist's
        one refusal then is that the annotation is not in it. Its refusals
        state no code, so each is `bus.rejected`. A timeout, a closed bus
        and an Archivist that is not there are no refusal, and are raised.
        """
        asked = BrowseAnnotationRequest(resource_id=resource_id, annotation_id=annotation_id)
        try:
            return (await self._bus.request(BROWSE_ANNOTATION_REQUESTED, asked)).response.annotation
        except BusRequestError as failure:
            if failure.code == "bus.rejected":
                return None
            raise


@final
class BusPeople(People):
    """What the knowledge base calls its people, as a Librarian reads it over `bus`."""

    def __init__(self, bus: Bus) -> None:
        self._bus: Final = bus

    @override
    async def of(self, dids: Sequence[str]) -> Mapping[str, PersonProfile]:
        """The profile of each of `dids` that has one, as the Archivist answers it now. Raises `PeopleUnread` where the read fails.

        A text that is no DID has no profile, and is not asked after; each
        DID is asked after once. Where nothing is to be asked after, nothing
        is asked. More people than one request may ask after are asked after
        in parts, in order.
        """
        asked = list(dict.fromkeys(did for did in (UserId.parse(text) for text in dids) if did is not None))
        profiles: dict[str, PersonProfile] = {}
        for start in range(0, len(asked), _ASKED_AT_ONCE):
            part = asked[start : start + _ASKED_AT_ONCE]
            try:
                profiles.update((await self._bus.request(BROWSE_PEOPLE_REQUESTED, BrowsePeopleRequest(dids=part))).response.people)
            except (BusRequestError, TransportError) as failure:
                raise PeopleUnread(f"What the knowledge base calls {len(asked)} people could not be read: {failure}") from failure
        return profiles
