"""A Weaver for a test: a real one, over a transport a test scripts and a graph in the process.

What stands in for the Archivist is the test itself: it says what the record
holds, and the rig answers the Weaver's three reads from that. The catalog
and each resource's annotations are answered as a view holds them, which here
is what a second graph, folded from the same record, holds.
"""

import asyncio
import hashlib
import tempfile
from collections.abc import Coroutine, Mapping, Sequence
from pathlib import Path
from types import TracebackType
from typing import Final, Self, final

from pydantic import JsonValue
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.testing import FaultyTransport
from semiont.transport import Frame
from semiont.types import StoredEventResponse
from semiont_graph.interface import ResourceQuery
from semiont_graph.memory import MemoryGraphDatabase
from spec import JsonObject

from semiont_weaver.checkpoint import Checkpoint
from semiont_weaver.fold import apply
from semiont_weaver.weaver import Weaver


def event(kind: str, resource: str | None, sequence: int, payload: JsonObject, *, at: str = "2020-03-04T05:06:07.000Z") -> JsonObject:
    """A recorded event, as the bus carries one."""
    stored: JsonObject = {
        "id": f"evt-{resource}-{sequence}-{kind}",
        "type": kind,
        "timestamp": at,
        "userId": "did:web:example.org:users:ada",
        "version": 1,
        "payload": payload,
        "metadata": {"sequenceNumber": sequence},
    }
    if resource is not None:
        stored["resourceId"] = resource
    return stored


ADA: Final[JsonObject] = {"@type": "Person", "@id": "did:web:example.org:users:ada"}


def tagged(resource: str, sequence: int, tag: str) -> JsonObject:
    return event("mark:entity-tag-added", resource, sequence, {"entityType": tag})


def archived(resource: str, sequence: int) -> JsonObject:
    return event("mark:archived", resource, sequence, {})


def removed(resource: str, sequence: int, annotation: str) -> JsonObject:
    return event("mark:removed", resource, sequence, {"annotationId": annotation})


def body_updated(resource: str, sequence: int, annotation: str, *operations: JsonValue, at: str) -> JsonObject:
    return event("mark:body-updated", resource, sequence, {"annotationId": annotation, "operations": [*operations]}, at=at)


def tag(value: str) -> JsonObject:
    return {"type": "TextualBody", "value": value, "purpose": "tagging"}


def link(to: str) -> JsonObject:
    return {"type": "SpecificResource", "source": to, "purpose": "linking"}


def created(resource: str, **payload: JsonValue) -> JsonObject:
    """The `yield:created` of a resource, at the first place in its record."""
    stated: JsonObject = {
        "name": f"Name of {resource}",
        "format": "text/markdown",
        # A checksum as the Archivist writes one: the SHA-256, in lower-case hex, with nothing before it.
        "contentChecksum": hashlib.sha256(resource.encode()).hexdigest(),
        "wasAttributedTo": ADA,
    }
    return event("yield:created", resource, 1, {**stated, **payload})


def added(resource: str, sequence: int, annotation: str, *body: JsonValue, **fields: JsonValue) -> JsonObject:
    """A `mark:added` of a reference on a resource, with the body items given."""
    stated: JsonObject = {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        "type": "Annotation",
        "id": annotation,
        "motivation": "linking",
        "target": {"source": resource, "selector": {"type": "TextQuoteSelector", "exact": "some words"}},
        "creator": ADA,
        "created": "2020-03-04T05:06:07.000Z",
    }
    if body:
        stated["body"] = [*body]
    return event("mark:added", resource, sequence, {"annotation": {**stated, **fields}})


@final
class Rig:
    """Held with `async with`: a Weaver that is following from the way in to the way out."""

    def __init__(self, *, kept: Path | None = None, after: "Rig | None" = None) -> None:
        """`kept` is where the Weaver keeps its marks. `after` is an earlier life of it, whose record, views and graph go on."""
        self.graph: Final[MemoryGraphDatabase] = MemoryGraphDatabase() if after is None else after.graph
        self.record: Final[dict[str, list[JsonObject]]] = {} if after is None else after.record
        """What the record holds: each resource's events, in the order they were recorded."""
        self.views: Final[MemoryGraphDatabase] = MemoryGraphDatabase() if after is None else after.views
        """What the record's views hold, as far as a Weaver reads them."""
        self.unanswered: Final[set[str]] = set()
        """The operations nobody answers: each is refused as a peer that is not there."""
        self.transport: Final = FaultyTransport(make_response=self._answer)
        self.transport.refuse_when(self._refuse)
        self._home: Final = tempfile.TemporaryDirectory()
        self.kept: Final = Path(self._home.name) / "marks.json" if kept is None else kept
        self.weaver: Final = Weaver(self.graph, self.transport, Checkpoint(self.kept))

    async def __aenter__(self) -> Self:
        await self.graph.connect()
        await self.views.connect()
        await self.weaver.__aenter__()
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        await self.weaver.__aexit__(kind, error, trace)
        await self.transport.close()
        self._home.cleanup()

    # ── What the record holds ──────────────────────────────────────────

    async def recorded(self, *events: JsonObject) -> None:
        """Put events in the record, as the Archivist does: kept, and folded into its views. Nothing is delivered."""
        for stored in events:
            resource = stored.get("resourceId")
            if isinstance(resource, str):
                self.record.setdefault(resource, []).append(stored)
            await apply(self.views, StoredEventResponse.model_validate(stored))

    def deliver(self, *events: JsonObject) -> None:
        """Deliver events to the Weaver, as the bus does: each on the channel of its type."""
        for stored in events:
            kind = stored["type"]
            assert isinstance(kind, str)
            self.transport.deliver(Frame(channel=kind, payload=stored))

    async def happened(self, *events: JsonObject) -> None:
        """Events that were recorded while the Weaver was following: recorded, delivered, and applied."""
        await self.recorded(*events)
        self.deliver(*events)
        await self.settled()

    def _refuse(self, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        del payload
        return {"code": "peer-unavailable", "message": "nothing answers"} if operation in self.unanswered else None

    def _answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
        # The two graphs are in the process, and their reads wait on nothing: each is run to its end here.
        resource = payload.get("resourceId")
        if operation == "browse:resources-requested":
            offset, limit = payload.get("offset"), payload.get("limit")
            assert isinstance(offset, int)
            assert isinstance(limit, int)
            listing = _now(self.views.list_resources(ResourceQuery(offset=offset, limit=limit)))
            resources: list[JsonValue] = [written(held) for held in listing.resources]
            return {"resources": resources, "total": listing.total, "offset": offset, "limit": limit}
        assert isinstance(resource, str), operation
        if operation == "browse:events-requested":
            events: list[JsonValue] = [{**stored, "agent": ADA} for stored in self.record.get(resource, [])]
            return {"events": events, "total": len(events), "resourceId": resource}
        if operation == "browse:annotations-requested":
            annotations: list[JsonValue] = [written(held) for held in _now(self.views.get_resource_annotations(ResourceId(resource)))]
            return {"annotations": annotations, "total": len(annotations)}
        raise AssertionError(f"the Weaver asked {operation}, which it is not to")

    # ── What the Weaver did ────────────────────────────────────────────

    async def settled(self) -> None:
        """Wait until the Weaver has applied every event delivered so far, signalled what it applied, and answered what it was commanded."""
        for _ in range(3):
            # A command is taken up a turn or two after it is delivered, and a reply is delivered a turn after it is sent.
            for _ in range(20):
                await asyncio.sleep(0)
            await self.weaver.settled()

    async def same_as_the_views(self) -> None:
        """The graph holds what the record's views hold: every resource, and every annotation of each."""
        everything = ResourceQuery(limit=1_000)
        held, of_record = (await self.graph.list_resources(everything)).resources, (await self.views.list_resources(everything)).resources
        assert [written(resource) for resource in held] == [written(resource) for resource in of_record]
        for resource in of_record:
            in_graph = [written(annotation) for annotation in await self.graph.get_resource_annotations(resource.id)]
            assert in_graph == [written(annotation) for annotation in await self.views.get_resource_annotations(resource.id)]

    def signalled(self) -> dict[str, list[int]]:
        """Each resource's marks, as the Weaver signalled them on `weave:applied`, in the order it did."""
        marks: dict[str, list[int]] = {}
        for frame in self.transport.emitted:
            if frame.channel == "weave:applied":
                resource, sequence = frame.payload["resourceId"], frame.payload["sequenceNumber"]
                assert isinstance(resource, str)
                assert isinstance(sequence, int)
                marks.setdefault(resource, []).append(sequence)
        return marks

    def answered(self, channel: str) -> Sequence[Frame]:
        """What the Weaver emitted on a channel."""
        return [frame for frame in self.transport.emitted if frame.channel == channel]


def _now[T](reading: Coroutine[object, None, T]) -> T:
    """What a read of a graph in the process answers. It waits on nothing, so it is run to its end where it stands."""
    try:
        reading.send(None)
    except StopIteration as done:
        answered: T = done.value
        return answered
    raise AssertionError("a read of a graph in the process waited on something")
