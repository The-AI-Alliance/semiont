"""What keeps a client's queries true: `protocol/specs/src/client/refresh.json` (`semiont.refresh`), applied to the client's caches.

Each event on the bus, the reopening of a dropped stream, and an event that
cannot be read, asks again for the queries its row names, writes the ones
whose new value the event carries, and ends the ones whose entity is gone.

A client has one refresher. What an event names (its resource, its
annotation, the value it carries) is read by the ways its row states. Which
cache answers each query of the table is a `match` over the table's own
names, so a query added to the table does not pass a type checker until it
is answered here.

An event acts only on a key its cache holds, and the refetches one key is
asked for inside a window are one refetch (`protocol/contract/CACHE-SEMANTICS.md`
B12 to B13b, B19, B20).
"""

import asyncio
from collections.abc import Callable, Hashable, Mapping
from typing import Final, assert_never, final

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.bus import decoded
from semiont.cache import Cache
from semiont.channels import CHANNELS
from semiont.events import Events
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.links import Links
from semiont.namespaces.live import WHOLE, Live, Subject
from semiont.refresh import (
    CACHE_REFRESH,
    CACHE_REFRESH_CHANNELS,
    CacheQuery,
    CacheRefreshChannel,
    CacheRefreshReach,
    CacheRefreshTrigger,
    CacheRefreshWay,
    CacheRefreshWhen,
)
from semiont.transport import ConnectionState, Frame, FrameRefusal
from semiont.types import Annotation
from semiont.watched import Watched

__all__ = ["Refresher"]

# The table's channels, by the name a frame gives its own.
_CHANNELS: Final[Mapping[str, CacheRefreshChannel]] = {channel: channel for channel in CACHE_REFRESH_CHANNELS}

_RESOURCE_ID: Final = TypeAdapter(ResourceId)
_ANNOTATION_ID: Final = TypeAdapter(AnnotationId)
_ANNOTATION: Final = TypeAdapter(Annotation)


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


@final
class _Unreadable(Exception):
    """An event a member of which its row names is present and is not what it names."""


def _member_at(payload: Mapping[str, JsonValue], way: CacheRefreshWay) -> JsonValue:
    """The member `way` ends at in `payload`: None where it, or a member it passes through, is absent or null.

    Raises `_Unreadable` where a member it passes through is present and is no object.
    """
    first, *through = way
    member = payload.get(first)
    for name in through:
        if member is None:
            return None
        if not isinstance(member, dict):
            raise _Unreadable
        member = member.get(name)
    return member


def _read[T](payload: Mapping[str, JsonValue], way: CacheRefreshWay | None, kind: TypeAdapter[T]) -> T | None:
    """What `way` names in `payload`, as a `kind`: None where the row states no way, or the way names none.

    Raises `_Unreadable` as `_member_at` does, and `ValidationError` where
    the member the way ends at is not a `kind`.
    """
    if way is None:
        return None
    member = _member_at(payload, way)
    return None if member is None else kind.validate_python(member)


def _named(channel: CacheRefreshChannel, payload: Mapping[str, JsonValue]) -> Subject:
    """What an event on `channel` names, by the ways of its row.

    A split channel's event is enriched when the member its enriched row
    carries is present and not null, which is read there as what the row
    carries. Raises `_Unreadable` or `ValidationError` for an event that
    cannot be read.
    """
    rows = CACHE_REFRESH[channel]
    enriched = next((row for row in rows if row.when == "enriched"), None)
    if enriched is None:
        (row,) = rows
    else:
        when: CacheRefreshWhen = "unenriched" if _read(payload, enriched.carries, _ANNOTATION) is None else "enriched"
        (row,) = (split for split in rows if split.when == when)
    return Subject(
        when=row.when,
        resource=_read(payload, row.names_resource, _RESOURCE_ID),
        annotation=_read(payload, row.names_annotation, _ANNOTATION_ID),
        written=_read(payload, row.carries, _ANNOTATION),
    )


def _subject_of(frame: Frame | FrameRefusal) -> tuple[CacheRefreshTrigger, Subject]:
    """The trigger a frame on one of the table's channels is, and what it names.

    It is `unreadable`, naming nothing, when the channel's reading refuses
    the frame or a member its row names is present and is not what it names.
    """
    if isinstance(frame, FrameRefusal):
        return "unreadable", Subject()
    channel = _CHANNELS[frame.channel]
    try:
        decoded(CHANNELS[channel], frame.payload)
        return channel, _named(channel, frame.payload)
    except (ValidationError, _Unreadable):
        return "unreadable", Subject()


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
        self._links.run(self._listen(self._links.own.frames_among(CACHE_REFRESH_CHANNELS)))
        self._links.run(self._reopenings(self._links.transport.state))

    async def _listen(self, events: Events[Frame | FrameRefusal]) -> None:
        # Its reader is given the frames of the table's channels and no others.
        async for frame in events:
            trigger, subject = _subject_of(frame)
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
        (row,) = (candidate for candidate in CACHE_REFRESH[trigger] if candidate.when == subject.when)
        for query in row.writes:
            self._live.write(query, subject)
        for query in row.removes:
            self._live.remove(query, subject)
        for query in row.refetches:
            self._refetch(query, subject, row.reach)

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
            case "engines":
                if live.engines.known(WHOLE):
                    self._windows.run("engines", live.invalidate_engines)
            case _:
                assert_never(query)

    def dispose(self) -> None:
        """Stop: what a window owed is dropped, and no window opens after. The client's close ends the listening."""
        self._windows.dispose()
