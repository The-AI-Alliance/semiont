"""What keeps a client's queries true: `specs/src/client/refresh.json` (`semiont.refresh`), applied to the client's caches.

Each event on the bus, and the reopening of a dropped stream, asks again for
the queries its row names, writes the ones whose new value the event carries,
and ends the ones whose entity is gone.

A client has one refresher. It states what each event names (its resource,
its annotation, the value it carries) and, for each query of the table, which
cache answers it. Both are a `match` over the table's own names, so a trigger
or a query added to the table does not pass a type checker until it is
answered here.

An event acts only on a key its cache holds, and the refetches one key is
asked for inside a window are one refetch (`docs/protocol/CACHE-SEMANTICS.md`
B12 to B13b, B19, B20).
"""

import asyncio
from collections.abc import Callable, Hashable, Mapping
from typing import Final, assert_never, final

from pydantic import JsonValue, ValidationError

from semiont.bus import decoded
from semiont.cache import Cache
from semiont.channel import Channel, ScopedChannel
from semiont.channels import (
    BUS_RESUME_GAP,
    FRAME_ENTITY_TYPE_ADDED,
    FRAME_TAG_SCHEMA_ADDED,
    MARK_ADDED,
    MARK_ARCHIVED,
    MARK_BODY_UPDATED,
    MARK_DELETE_OK,
    MARK_ENTITY_TAG_ADDED,
    MARK_ENTITY_TAG_REMOVED,
    MARK_REMOVED,
    MARK_UNARCHIVED,
    YIELD_CLONED,
    YIELD_CREATED,
    YIELD_MOVED,
    YIELD_UPDATED,
)
from semiont.events import Events
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.namespaces.live import WHOLE, Live, Subject
from semiont.refresh import CACHE_QUERIES, CACHE_REFRESH, CacheQuery, CacheRefreshReach, CacheRefreshTrigger
from semiont.transport import ConnectionState, Frame
from semiont.types import StoredEventResponse
from semiont.watched import Watched

__all__ = ["Refresher"]

# The triggers that are events, by the channel each is.
_EVENTS: Final[Mapping[str, CacheRefreshTrigger]] = {trigger: trigger for trigger in CACHE_REFRESH if trigger != "reopened"}


@final
class _Window:
    def __init__(self, refetch: Callable[[], None], closing: asyncio.TimerHandle) -> None:
        self.refetch: Final = refetch
        """What asks again for the window's key."""
        self.closing: Final = closing
        self.owed = False
        """Whether it was asked for again while the window was open."""


@final
class _Windows:
    """B19: per key, the first refetch an event asks for runs at once and opens a window.

    Any more inside it are owed, and run as one when it closes, which opens
    the next. So a storm of events costs a refetch per key per window, and
    the last event is always reflected.
    """

    def __init__(self, lasting_ms: int) -> None:
        self._lasting: Final = lasting_ms / 1000
        self._open: Final[dict[str, _Window]] = {}

    def run(self, key: str, refetch: Callable[[], None]) -> None:
        """Ask again for `key`, by `refetch`: what asks for one key is the same whichever event asked."""
        window = self._open.get(key)
        if window is not None:
            window.owed = True
            return
        self._open[key] = _Window(refetch, asyncio.get_running_loop().call_later(self._lasting, self._close, key))
        refetch()

    def _close(self, key: str) -> None:
        window = self._open.pop(key)
        if window.owed:
            self.run(key, window.refetch)

    def dispose(self) -> None:
        """Every window closes, and what each owed is dropped."""
        for window in self._open.values():
            window.closing.cancel()
        self._open.clear()


def _annotation_named(payload: Mapping[str, JsonValue]) -> AnnotationId | None:
    named = payload.get("annotationId")
    return AnnotationId.parse(named) if isinstance(named, str) else None


def _recorded(channel: Channel[StoredEventResponse] | ScopedChannel[StoredEventResponse], payload: Mapping[str, JsonValue]) -> Subject:
    return Subject(resource=decoded(channel, payload).resource_id)


def _named(trigger: CacheRefreshTrigger, payload: Mapping[str, JsonValue]) -> Subject:
    """What an event names. Each arm states it for its trigger, and a trigger with no arm does not pass a type checker.

    Raises `ValidationError` for a payload that is not its channel's.
    """
    match trigger:
        case "reopened":
            # No event: the stream's reopening names nothing.
            return Subject()
        case "bus:resume-gap":
            return Subject(resource=decoded(BUS_RESUME_GAP, payload).scope)
        case "mark:added":
            return Subject(resource=decoded(MARK_ADDED, payload).resource_id)
        case "mark:removed":
            removed = decoded(MARK_REMOVED, payload)
            return Subject(resource=removed.resource_id, annotation=_annotation_named(removed.payload))
        case "mark:delete-ok":
            return Subject(annotation=decoded(MARK_DELETE_OK, payload).response.annotation_id)
        case "mark:body-updated":
            updated = decoded(MARK_BODY_UPDATED, payload)
            if updated.annotation is not None:
                return Subject(when="enriched", resource=updated.resource_id, annotation=updated.annotation.id, written=updated.annotation)
            return Subject(when="unenriched", resource=updated.resource_id, annotation=_annotation_named(updated.payload))
        case "mark:entity-tag-added":
            return _recorded(MARK_ENTITY_TAG_ADDED, payload)
        case "mark:entity-tag-removed":
            return _recorded(MARK_ENTITY_TAG_REMOVED, payload)
        case "mark:archived":
            return _recorded(MARK_ARCHIVED, payload)
        case "mark:unarchived":
            return _recorded(MARK_UNARCHIVED, payload)
        # What is heard by every client: its resource is the one it records, not a scope the client holds.
        case "yield:created":
            return _recorded(YIELD_CREATED, payload)
        case "yield:updated":
            return _recorded(YIELD_UPDATED, payload)
        case "yield:cloned":
            return _recorded(YIELD_CLONED, payload)
        case "yield:moved":
            return _recorded(YIELD_MOVED, payload)
        case "frame:entity-type-added":
            decoded(FRAME_ENTITY_TYPE_ADDED, payload)
            return Subject()
        case "frame:tag-schema-added":
            decoded(FRAME_TAG_SCHEMA_ADDED, payload)
            return Subject()
        case _:
            assert_never(trigger)


@final
class Refresher:
    """See the module's documentation. It listens from `start` until its client closes."""

    def __init__(self, links: Links, live: Live, *, invalidation_window_ms: int) -> None:
        self._links: Final = links
        self._live: Final = live
        self._windows: Final = _Windows(invalidation_window_ms)

    def start(self) -> None:
        """Listen, from now on. A client starts it once: when it is held."""
        # Listening before the task that reads has had its first turn: nothing said meanwhile is missed.
        self._links.run(self._listen(self._links.own.frames_among(tuple(_EVENTS))))
        self._links.run(self._reopenings(self._links.wire.transport.state))

    async def _listen(self, events: Events[Frame]) -> None:
        async for frame in events:
            # Its reader is given the frames of these channels and no others.
            trigger = _EVENTS[frame.channel]
            try:
                subject = _named(trigger, frame.payload)
            except ValidationError:
                # An event that cannot be read: something changed and nothing
                # says what. Everything held is asked for again, as after a gap.
                self._everything_held()
                continue
            self._refresh(trigger, subject)

    async def _reopenings(self, state: Watched[ConnectionState]) -> None:
        """B13: the stream is open again having left `open`, which only a drop does.

        A changed subscription is handed over with the state still `open`,
        and misses nothing.
        """
        opened = left = False
        # A reopening is seen as one because a transport waits on its
        # connection between leaving `open` and reaching it again, and this
        # task runs in that wait.
        async for now in state:
            if now == "open":
                if left:
                    self._refresh("reopened", Subject())
                opened, left = True, False
            else:
                left = opened

    def _refresh(self, trigger: CacheRefreshTrigger, subject: Subject) -> None:
        row = next((row for row in CACHE_REFRESH[trigger] if row.when == subject.when), None)
        if row is None:
            return
        for query in row.writes:
            self._live.write(query, subject)
        for query in row.removes:
            self._live.remove(query, subject)
        for query in row.refetches:
            self._refetch(query, subject, row.reach)

    def _everything_held(self) -> None:
        for query in CACHE_QUERIES:
            self._refetch(query, Subject(), "held")

    def _again[K: Hashable, V](self, cache: Cache[K, V], key: K, window: str) -> None:
        """Ask again for one key, when the cache holds it (B20), through the key's window (B19)."""
        if cache.known(key):
            self._windows.run(window, lambda: cache.invalidate(key))

    def _refetch(self, query: CacheQuery, subject: Subject, reach: CacheRefreshReach) -> None:
        """B7: ask again, for the keys the row reaches, showing what there is meanwhile.

        Each arm names the cache that answers its query, and a query with no
        arm does not pass a type checker.
        """
        live = self._live

        def reached(held: list[ResourceId]) -> list[ResourceId]:
            match reach:
                case "held":
                    return held
                case "subject":
                    return [] if subject.resource is None else [subject.resource]

        match query:
            case "resource":
                for resource in reached(live.resource.keys()):
                    self._again(live.resource, resource, f"resource/{resource}")
            case "annotations":
                for resource in reached(live.annotations.keys()):
                    self._again(live.annotations, resource, f"annotations/{resource}")
            case "events":
                for resource in reached(live.events.keys()):
                    self._again(live.events, resource, f"events/{resource}")
            case "referencedBy":
                for resource in reached(live.referenced_by.keys()):
                    self._again(live.referenced_by, resource, f"referenced-by/{resource}")
            case "annotation":
                # The annotation the event names; when it names none, each one held of the resource it names.
                if reach == "held":
                    annotations = live.annotation.keys()
                elif subject.annotation is not None:
                    annotations = [subject.annotation]
                else:
                    annotations = [annotation for annotation, of in live.annotation_of.items() if of == subject.resource]
                for annotation in annotations:
                    self._again(live.annotation, annotation, f"annotation/{annotation}")
            # An event does not say which lists it changes, nor which searches would now find its resource.
            case "resources":
                self._windows.run("resource-lists", live.lists.invalidate_all)
            case "matchedResources":
                self._windows.run("matched-resources", live.searches.invalidate_all)
            case "entityTypes":
                self._again(live.entity_types, WHOLE, "entity-types")
            case "tagSchemas":
                self._again(live.tag_schemas, WHOLE, "tag-schemas")
            case "agents":
                if live.agents.known(WHOLE):
                    self._windows.run("agents", live.invalidate_agents)
            case _:
                assert_never(query)

    def dispose(self) -> None:
        """Stop: what a window owed is dropped, and no window opens after. The client's close ends the listening."""
        self._windows.dispose()
