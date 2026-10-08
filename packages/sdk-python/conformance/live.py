"""The live driver: this SDK's client, its live queries and their cache, as `tests/conformance/sdk/live` drives it.

It reaches the SDK only as an application does, through what `semiont`
exports, so what the suite observes is what a caller of the SDK gets.
"""

import asyncio
import sys
from collections.abc import AsyncIterator, Sequence
from contextlib import AsyncExitStack
from typing import Final, assert_never, final

from protocol import Arguments, Misuse, Operation, count, failure, object_of, say, serve, text
from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.cache import CacheState, Failed, Pending, Ready
from semiont.cached import Cached
from semiont.client import CachePersistence, ClientTiming, SemiontClient
from semiont.errors import SemiontError
from semiont.events import Events
from semiont.http import HttpTransport, Timing
from semiont.identifiers import AnnotationId, InvalidIdentifier, ResourceId
from semiont.model import WireModel
from semiont.namespaces.browse import Collaborator
from semiont.namespaces.follow import Delegation
from semiont.refresh import CACHE_QUERIES, CacheQuery
from semiont.storage import MemoryStorage
from semiont.transport import ConnectionState
from semiont.types import GenerationJobParams, JobCompleteCommand, MarkJobParams
from semiont.watched import Variable

type _Shown = WireModel | Collaborator | str | Sequence[_Shown]
"""What a live query's value is made of."""

_MARK_PARAMS: Final = TypeAdapter[MarkJobParams](MarkJobParams)


def _resource(args: Arguments, name: str) -> ResourceId:
    try:
        return ResourceId(text(args, name))
    except InvalidIdentifier as error:
        raise Misuse(f"{name} is not a resource's id: {error}") from error


def _annotation(args: Arguments, name: str) -> AnnotationId:
    try:
        return AnnotationId(text(args, name))
    except InvalidIdentifier as error:
        raise Misuse(f"{name} is not an annotation's id: {error}") from error


def _as_the_wire_had_it(value: _Shown) -> JsonValue:
    """A query's value as JSON: by the wire's names, and without what the knowledge base never said."""
    if isinstance(value, str):
        return value
    if isinstance(value, WireModel):
        return value.model_dump(mode="json", exclude_unset=True)
    if isinstance(value, Collaborator):
        # The limits sit beside the entry's own fields.
        entry: dict[str, JsonValue] = value.entry.model_dump(mode="json", exclude_unset=True)
        if value.limits is not None:
            entry["limits"] = value.limits.model_dump(mode="json", exclude_unset=True)
        return entry
    return [_as_the_wire_had_it(item) for item in value]


def _state(state: CacheState[_Shown]) -> dict[str, JsonValue]:
    match state:
        case Pending():
            return {"status": "pending"}
        case Ready(value=value):
            return {"status": "ready", "value": _as_the_wire_had_it(value)}
        case Failed(error=error):
            return {"status": "failed", "error": failure(error)}


def _named(query: Arguments) -> CacheQuery:
    """The live query of `specs/src/client/refresh.json` a case names."""
    name = text(query, "query")
    for known in CACHE_QUERIES:
        if known == name:
            return known
    raise Misuse(f"no live query {name}")


def _limit(filters: Arguments) -> int:
    return count(filters, "limit") if "limit" in filters else 100


def _archived(filters: Arguments) -> bool | None:
    stated = filters.get("archived")
    if stated is not None and not isinstance(stated, bool):
        raise Misuse("archived must be true or false")
    return stated


def _filters(query: Arguments) -> Arguments:
    """The filters a case states for a list of resources, or for a search."""
    filters: Arguments = object_of(query, "filters") if "filters" in query else {}
    for name in filters:
        if name not in ("limit", "archived", "entityType"):
            raise Misuse(f"a filter by {name}, which no query of resources takes")
    return filters


def _entity_type(filters: Arguments) -> str | None:
    return text(filters, "entityType") if "entityType" in filters else None


def _query(client: SemiontClient[HttpTransport], query: Arguments) -> Cached[_Shown]:
    """The live query a case names. A query of the table with no arm does not pass a type checker."""
    named = _named(query)
    match named:
        case "resource":
            return client.browse.resource(_resource(query, "resource"))
        case "annotations":
            return client.browse.annotations(_resource(query, "resource"))
        case "annotation":
            return client.browse.annotation(_resource(query, "resource"), _annotation(query, "annotation"))
        case "events":
            return client.browse.events(_resource(query, "resource"))
        case "referencedBy":
            return client.gather.referenced_by(_resource(query, "resource"))
        case "resources":
            filters = _filters(query)
            return client.browse.resources(limit=_limit(filters), archived=_archived(filters), entity_type=_entity_type(filters))
        case "matchedResources":
            filters = _filters(query)
            return client.match.resources(
                text(query, "search"), limit=_limit(filters), archived=_archived(filters), entity_type=_entity_type(filters)
            )
        case "entityTypes":
            return client.browse.entity_types()
        case "tagSchemas":
            return client.browse.tag_schemas()
        case "agents":
            return client.browse.agents()
        case _:
            assert_never(named)


def _timings(stated: Arguments) -> tuple[Timing, ClientTiming]:
    """The timing a case states, each entry by its name in `specs/src/client/timing.json`."""
    wire, client = Timing(), ClientTiming()
    reconnect_ms, lazy_remove_ms, linger_ms = wire.reconnect_ms, wire.lazy_remove_ms, wire.linger_ms
    bus_request_ms, invalidation_window_ms = client.bus_request_ms, client.invalidation_window_ms
    job_silence_ms, job_status_poll_ms = client.job_silence_ms, client.job_status_poll_ms
    for name in stated:
        match name:
            case "reconnectMs":
                reconnect_ms = count(stated, name)
            case "lazyRemoveMs":
                lazy_remove_ms = count(stated, name)
            case "lingerMs":
                linger_ms = count(stated, name)
            case "busRequestTimeoutMs":
                bus_request_ms = count(stated, name)
            case "invalidationWindowMs":
                invalidation_window_ms = count(stated, name)
            case "jobSilenceMs":
                job_silence_ms = count(stated, name)
            case "jobStatusPollMs":
                job_status_poll_ms = count(stated, name)
            case _:
                raise Misuse(f"this driver cannot override {name}")
    return (
        Timing(
            reconnect_ms=reconnect_ms,
            lazy_remove_ms=lazy_remove_ms,
            linger_ms=linger_ms,
            emit_retry=wire.emit_retry,
            seen_event_ids_count=wire.seen_event_ids_count,
        ),
        ClientTiming(
            bus_request_ms=bus_request_ms,
            job_silence_ms=job_silence_ms,
            job_status_poll_ms=job_status_poll_ms,
            invalidation_window_ms=invalidation_window_ms,
        ),
    )


@final
class Live:
    """One client, and what the suite asked it to report."""

    def __init__(self, held: AsyncExitStack, reporters: asyncio.TaskGroup) -> None:
        self._held: Final = held
        self._reporters: Final = reporters
        self._storage: Final = MemoryStorage()
        """What a cache is kept in, across `close` and the next `open`: a reload, to the client."""
        self._transport: HttpTransport | None = None
        self._client: SemiontClient[HttpTransport] | None = None
        """The client, kept once closed: what a closed client does is part of what the suite asks."""
        self._closed = False
        self._observers: Final[dict[str, asyncio.Task[None]]] = {}
        """Each observer's task, by the name the suite gave it."""
        self._reported: ConnectionState | None = None

    def _opened(self) -> SemiontClient[HttpTransport]:
        if self._client is None:
            raise Misuse("no client is open")
        return self._client

    def _report(self, state: ConnectionState) -> None:
        if state != self._reported:
            self._reported = state
            say({"state": state})

    async def _states(self, transport: HttpTransport) -> None:
        async for state in transport.state:
            self._report(state)

    async def _failures(self, failures: Events[SemiontError]) -> None:
        async for error in failures:
            say({"error": failure(error)})

    async def open(self, _: int, args: Arguments) -> JsonValue:
        if self._client is not None and not self._closed:
            raise Misuse("a client is already open")
        wire, timing = _timings(object_of(args, "timing") if "timing" in args else {})
        transport = HttpTransport(text(args, "baseUrl"), token=Variable[str | None](text(args, "token")), timing=wire)
        persistence = CachePersistence(storage=self._storage, key_prefix="conformance") if args.get("persist") is True else None
        self._transport = await self._held.enter_async_context(transport)
        self._client = await self._held.enter_async_context(
            SemiontClient(transport, transport.content, transport, timing=timing, persistence=persistence)
        )
        self._closed = False
        self._observers.clear()
        self._reported = None
        self._reporters.create_task(self._states(transport))
        self._reporters.create_task(self._failures(transport.failures()))
        return None

    async def close(self, _: int, __: Arguments) -> JsonValue:
        await self._opened().close()
        if self._transport is not None:
            await self._transport.close()
        self._closed = True
        return None

    def _free(self, args: Arguments) -> str:
        """The observer a case names, which is nobody's yet."""
        observer = text(args, "observer")
        if observer in self._observers:
            raise Misuse(f"{observer} is already observing")
        return observer

    async def _watching(self, name: str, live: AsyncIterator[CacheState[_Shown]], held: AsyncExitStack) -> None:
        """Report each state the query is in, as the observer `name`, and its end."""
        async with held:
            async for state in live:
                say({"emission": {"observer": name, "state": _state(state)}})
        say({"completed": name})

    async def observe(self, _: int, args: Arguments) -> JsonValue:
        client = self._opened()
        observer = self._free(args)
        # Held before this is answered: what the suite does next finds the query observed.
        held = AsyncExitStack()
        live = await held.enter_async_context(_query(client, object_of(args, "query")))
        self._observers[observer] = self._reporters.create_task(self._watching(observer, live, held))
        return None

    async def unobserve(self, _: int, args: Arguments) -> JsonValue:
        observer = text(args, "observer")
        watching = self._observers.pop(observer, None)
        if watching is None:
            raise Misuse(f"{observer} is not observing")
        watching.cancel()
        await asyncio.gather(watching, return_exceptions=True)
        return None

    async def fresh(self, _: int, args: Arguments) -> JsonValue:
        """A one-shot read of the live query a case names."""
        value = await _query(self._opened(), object_of(args, "query")).fresh()
        return {"value": _as_the_wire_had_it(value)}

    async def invalidate(self, _: int, args: Arguments) -> JsonValue:
        _query(self._opened(), object_of(args, "query")).invalidate()
        return None

    async def _following[C: JobCompleteCommand](self, name: str, job: Delegation[C]) -> None:
        """A delegated job followed to its end, observed as a live query is.

        Each event it reports is a `ready` state, its failure a `failed` one,
        its end a completion.
        """
        try:
            async for event in job:
                value: dict[str, JsonValue] = {"kind": event.kind, "data": event.data.model_dump(mode="json", exclude_unset=True)}
                say({"emission": {"observer": name, "state": {"status": "ready", "value": value}}})
        except SemiontError as error:
            say({"emission": {"observer": name, "state": {"status": "failed", "error": failure(error)}}})
        say({"completed": name})

    async def mark_delegate(self, _: int, args: Arguments) -> JsonValue:
        """A `mark` job on `resource`, of the `params` it is created with."""
        client = self._opened()
        observer = self._free(args)
        try:
            params = _MARK_PARAMS.validate_python(object_of(args, "params"))
        except ValidationError as error:
            raise Misuse(f"params: {error}") from error
        job = client.mark.delegate(_resource(args, "resource"), params)
        self._observers[observer] = self._reporters.create_task(self._following(observer, job))
        return None

    async def yield_delegate(self, _: int, args: Arguments) -> JsonValue:
        """A `yield` job of the `params` it is created with, whose follower gives up on it after `stallDeadlineMs` of silence."""
        client = self._opened()
        observer = self._free(args)
        try:
            params = GenerationJobParams.model_validate(object_of(args, "params"))
        except ValidationError as error:
            raise Misuse(f"params: {error}") from error
        job = client.yield_.delegate(params, stall_deadline_ms=count(args, "stallDeadlineMs"))
        self._observers[observer] = self._reporters.create_task(self._following(observer, job))
        return None

    async def delete(self, _: int, args: Arguments) -> JsonValue:
        await self._opened().mark.delete(_resource(args, "resource"), _annotation(args, "annotation"))
        return None

    async def sync(self, _: int, __: Arguments) -> JsonValue:
        # Answers after everything the client reported before it: the suite's
        # way to know it has read every state an observer was in.
        return None

    async def dispose(self) -> None:
        if self._client is not None:
            await self._client.close()
        if self._transport is not None:
            await self._transport.close()

    def operations(self) -> dict[str, Operation]:
        return {
            "open": Operation(self.open, in_turn=True),
            "close": Operation(self.close, in_turn=True),
            "observe": Operation(self.observe, in_turn=True),
            "unobserve": Operation(self.unobserve, in_turn=True),
            "fresh": Operation(self.fresh),
            "invalidate": Operation(self.invalidate, in_turn=True),
            "markDelegate": Operation(self.mark_delegate, in_turn=True),
            "yieldDelegate": Operation(self.yield_delegate, in_turn=True),
            "delete": Operation(self.delete),
            "sync": Operation(self.sync, in_turn=True),
        }


async def main() -> int:
    # The reporters end when what they read is closed, which `dispose` does.
    async with AsyncExitStack() as held, asyncio.TaskGroup() as reporters:
        live = Live(held, reporters)
        return await serve(live.operations(), live.dispose)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
